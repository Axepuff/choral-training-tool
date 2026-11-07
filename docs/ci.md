# Выбор проверок и допуск frontend — Issue #66

Источник выбора — `scripts/ci.py`, workflow — `.github/workflows/checks.yml`.
Новые зависимости не добавлены. Классификатор использует только Python stdlib.

## Diff и карта проверок

PR сравнивает merge-base base/head с head PR; проверяется checkout merge ref.
Push main сравнивает `before` с `after`, включая все коммиты push. Checkout имеет
полную историю. NUL-разделители сохраняют пробелы в именах; при переименовании
учитываются старый и новый пути, удаления тоже остаются в diff. Если before
нулевой/недоступен, выбирается весь набор. Неизвестные пути также включают весь
набор, а ошибка вычисления/разбора не разрешает выпуск.

| Изменение | Автоматические проверки | Почему достаточно / ограничение |
| --- | --- | --- |
| CSS, шрифты в src | frontend: lint, typecheck, production build | Поведение не меняется; оценка stories и состояний вручную по матрице ниже |
| SignIn / ChangePassword / auth / navigation | frontend, auth unit, auth browser; для общих auth/navigation также songs browser | Cookies, password gate и навигация проверяются настоящим Go API |
| CreateSong / SongLibrary | frontend, stories компонента и workflow, songs browser | Формы, валидация, upload и сохранение |
| RehearsalPlayer / TrackControls | frontend, выбранные stories, audio unit/browser, songs browser | Состояния транспорта и фактический playback |
| src/audio | frontend, audio unit/browser, songs browser | PCM/decoder/loop плюс реальный серверный media flow |
| src/api | frontend, auth unit, auth и songs browser | Общий HTTP/CSRF/public client и реальные потребители |
| Общие UI-компоненты | frontend, все stories, auth/audio и оба browser flow | Общие controls используются всеми экранами |
| Только stories / mocks компонентов | frontend, stories компонента и workflow | Проверяется изменённый пример; runtime API не меняется |
| Backend / миграции | Go suite/vet/build, оба browser flow | Один Go-сервис и общая SQLite: пакетная оптимизация здесь намеренно не вводится |
| Backup scripts / systemd backup | профильные backup checks, изолированный container/restore | Ошибки восстановления и сохранность данных; реальные volumes только тестовые |
| nginx / Caddy | proxy-log и Caddy TLS/privacy checks | Включая исполняемые примеры в docs/operations.md и docs/deployment.md |
| Docker / Compose / env | container/restore, frontend mount, backup, proxy, release checks | Проверяются упаковка и настройки одного origin |
| Frontend release tooling | frontend + release/backup/container checks | Формат архива, atomic switch/rollback, старые assets, внешний mount |
| Документация Markdown | выбор проверок, его быстрые контрактные тесты, итоговый check | Кроме API-контракта и документов с исполняемыми proxy-примерами |
| Queue scripts | queue tests | Полномочия/правила контроллера не изменены |
| Lockfiles, общие config, workflows, CI/delivery tooling, неизвестный путь | все задания | Консервативная ветка; неопределённость не становится ложным успехом |

Смешанные diff объединяют наборы. TS/TSX **не объявляются визуальными** по пути,
расширению или метке PR. Даже изменение только JSX попадёт в поведенческую ветку:
надёжно доказать отсутствие влияния обработчиков/состояния по имени файла нельзя.
Если потребуется более точное распознавание, это отдельное расширение с проверкой
фактического diff; ручного флага отключения обязательных проверок сейчас нет.

`CHORAL_STORIES` передаёт точные glob выбранных stories в существующий Storybook
config. Runner выполняет все stories/play **получившегося индекса**, отказывает
при пустом индексе. Без переменной локальный Storybook работает как прежде.
Для общих UI/config и неизвестных изменений нужен полный индекс; для CSS его
сборка автоматически не выполняется.

## Что проверяется вручную для визуальных изменений

Автор и reviewer смотрят затронутые stories в dev Storybook: 320×640, 360×800,
800×360 и desktop 1280×900. Проверить overflow, 44×44 px области касания,
hover/pressed/selected/disabled, клавиатурный focus и доступность действий.
Записать story IDs, размеры и результат в PR; для глобальных токенов/оболочки
проверить экраны-потребители. CI build не подтверждает внешний вид или устройство.
Автоматика не умеет подтверждать человеческое наблюдение: это условие ручного
ревью, а не притворный зелёный screenshot check.

## Итоговый check и защита main

`Required checks` запускается с `always()` после changes/frontend/backend/e2e/
infrastructure/queue. `scripts/ci.py gate` требует success выбранных заданий и
skipped невыбранных. Failure/cancelled/missing/неожиданный skipped — ошибка.
Сбой выбора тоже блокирует итог. Если workflow отменён до старта итогового job,
успешного required check нет. `continue-on-error` и маскирующих retries нет.

На 7 ноября 2026 GitHub API показал main `protected=false`, contexts пусты,
repository rulesets `[]`. Настройки защиты этим PR **не изменяются**.
После появления нового check рекомендуется включить branch protection/ruleset
для main с обязательным **Required checks** (GitHub Actions). Прежние отдельные
frontend/backend/e2e не делать обязательными: они теперь намеренно пропускаются.
При появлении защиты до merge сверить фактические требования ещё раз.
Пока защита отключена, GitHub технически не запрещает ручной merge с красным CI;
скрипт доставки всё равно откажет в допуске такого артефакта.

## Проверенные байты и доставка

Frontend job один раз вызывает существующий `frontend-release.py build`:
production, base=/, Vite manifest, точный SHA checkout и checksum tar. Candidate
`frontend-<commit>` сохраняется на 30 дней. Он сам по себе не разрешает публикацию.
Только успешный итоговый check на push main сохраняет отдельный
`frontend-admission-<commit>`: commit, checksum, API label, run ID и attempt.
Артефакт merge ref PR никогда не получает такой допуск. После merge нужен
успешный push-run для фактического main commit, а не пересборка при доставке.

`frontend-delivery.py prepare` читает GitHub Actions через уже авторизованный
`gh`, проверяет репозиторий, workflow, push/main, SHA, завершённый success всего
run, `Required checks`, актуальный attempt и admission. Затем сверяет архив
существующим валидатором #65. Недостающий/истёкший артефакт или checksum mismatch
не заменяются локальной пересборкой. Повторно запустить исходный CI можно явно;
это новый допуск, а не скрытая часть deploy. CI не имеет production secrets.

Оператор указывает фактические backend commit/image и явно подтверждает
совместимость API. Скрипт требует доступной полной Git-истории и backend commit
в предках frontend commit; изменения backend/API-контракта с того момента
блокируют независимый выпуск (кроме Markdown, Go tests и static frontend handler).
Изменение использования API в TS не всегда видно как изменение OpenAPI:
флаг `--confirm-compatible` означает содержательное ревью против установленного
backend, а не автоматически доказанную совместимость. Если новый frontend
требует нового API, сначала согласованный backend release по общему runbook.

Команды получения, публикации и короткого smoke — в
[frontend-deployment.md](frontend-deployment.md#артефакт-из-ci--issue-66).
Скрипт prepare ничего не публикует; smoke не меняет данные. Фактическая публикация
остаётся явной командой существующего publish и не вызывает Docker/SQL/backup.

Storybook/Pages — отдельная демонстрация. `Publish Storybook` теперь запускается
явно через workflow_dispatch: push с CSS больше не вызывает параллельную полную
сборку Storybook. До ручной публикации Pages показывает предыдущую версию.
Production frontend не берётся из Pages/demo и публикуется из допущенного tar.

## Воспроизведение и результаты

```sh
python3 scripts/check-ci.py
python3 scripts/ci.py plan --base <base-sha> --head <head-sha>
python3 scripts/ci.py plan --paths src/styles/tokens.css docs/handoff.md
```

Контрактные тесты создают настоящий временный Git-репозиторий и проверяют PR с
продвинувшейся base-веткой, push из нескольких commits, rename code→docs, удаление,
нулевой/недоступный before. Отдельно вызывают CLI gate с success/failure/cancelled/
skipped/missing и проверяют факт появления admission-файла. Delivery отвергает
неверный run/commit/workflow/repository, PR-источник и устаревшую попытку.

Базовый CI на документационном PR #68:
[run 41524366473](https://github.com/Axepuff/choral-training-tool/actions/runs/41524366473):
frontend **125 с**, backend **122 с**, e2e **86 с**; всего **333 job-секунды**,
от одновременного старта jobs до завершения последнего **125 с**, без очереди.
Новый план для такого diff пропускает все пять тяжёлых jobs; CSS оставляет только
frontend без audio/stories/Go/e2e. Локальный новый контрактный набор занимает около
2–3 с в Windows/WSL. Это не замер времени GitHub runners: точное ускорение обычного
CSS/docs PR будет зависеть от старта runner/cache и должно измеряться после merge.

Изменение самого CI #66 намеренно выбирает полный набор, включая ранее отдельные
container/restore проверки. Его длительность нельзя выдавать за стоимость
визуального PR. Локально полные frontend/audio/Go/e2e suites не дублируются:
проверяются новая маршрутизация, workflow syntax, выбранные stories и release smoke;
полный интеграционный прогон выполняет автоматический CI этого PR.
