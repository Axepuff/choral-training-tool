# Деплой одной командой — Issue #80

После однократной настройки на сервере:

```sh
# Frontend + backend из последнего main с успешным CI:
sudo choral-deploy
# Выпустить конкретный проверенный commit:
sudo choral-deploy full --commit <40-hex-SHA>
# Только интерфейс, без остановки backend, после проверки совместимости API:
sudo choral-deploy frontend --commit <40-hex-SHA> --confirm-compatible
# То же с компьютера оператора:
ssh velette 'sudo -n choral-deploy'
```

Команда подготовлена в репозитории. Её наличие не означает установки на velette.
GitHub-кнопка и production credentials в Actions не добавляются: SSH-команда
использует тот же сценарий без дополнительного CI runner на сервере.

## Что выполняет команда

Оба режима берут общий `/run/lock/choral-maintenance.lock`, используемый ночным
backup. Конкурирующий запуск немедленно завершается с ошибкой. Checkout должен
быть чистым, на `main`; выполняется fetch, проверяется ancestry выбранного commit
и успешный последний push/main run `.github/workflows/checks.yml`, включая
`Required checks`. Нет готового CI — отказ, без скрытого rerun или публикации
непроверенного HEAD. Указание commit рекомендуется для воспроизводимого выпуска.

**Full:** Dockerfile выбранного commit собирается заранее из отдельного `git archive`.
Это обычная сборка полного образа по [operations.md](operations.md), а не доставка
байтов frontend-артефакта CI. Образ получает отдельный тег и OCI revision label;
старый образ не удаляется. Фронтенд извлекается из этого же образа и проверяется
валидатором release. При внешнем frontend root он публикуется туда; без override
продолжает раздаваться `/app` из образа. Immutable frontend commit нельзя заменить
другой сборкой: при коллизии команда откажет до остановки приложения.

Затем команда останавливает app, проверяет exit 0, выполняет штатный полный
backup private volume и внешнего фронтенда, проверяет checksum и, если задана,
делает вторую копию на отдельный диск. Сохраняются прежние image ID, commit и `.env`.
Checkout fast-forward обновляется, в `.env` меняется только `CHORAL_IMAGE_TAG`.
Развёрнутый Compose сравнивается с прежним: разрешена только смена image.

Новый backend сначала запускается как временный Compose-контейнер на отдельном
loopback-порту, с тем же volume, пока основной app остановлен. Здесь выполняются
миграции, readiness, HTTP-проверки frontend/API и чтение контрольной песни, media,
peaks и Range. После успешной проверки временный контейнер штатно останавливается,
проверяется exit 0 и удаляется. Только затем пересоздаётся app на обычном порту
и проверяется публичный origin. Caddy, TLS, firewall и соседние проекты не меняются.
Во время остановки app публичный прокси может возвращать 502; нулевой downtime
не обещается. Время перерыва включает backup, вторую копию и проверки.

**Frontend:** получает существующий допущенный CI tar через `frontend-delivery.py`,
проверяет API/установленный backend, сохраняет прежний frontend и выполняет
publish + HTTP smoke. Docker используется только для чтения состояния; контейнер,
Git HEAD backend и private volume не меняются. При ошибке smoke выполняется
rollback предыдущего frontend и повторная HTTP-проверка. Если rollback не удался,
журнал остаётся незавершённым. Флаг совместимости — результат содержательного
ревью использования API, а не автоматическое доказательство по diff.

## Однократная установка

Использовать отдельный чистый deployment checkout `/opt/choral`, существующий
Compose project и volume. Перед первым запуском сверить его HEAD с **фактически
установленным** backend image. Старые образы без OCI revision используют явно
записанный `initial_backend_commit`; после полного выпуска действует label образа.
Не подставлять текущий development main вместо установленной версии.

Нужны Linux, Python 3.11+, Git с полной историей и доступом fetch, Docker/Compose,
`gh` с чтением Actions, `tar`, `sha256sum`. `gh` должен быть авторизован именно для
пользователя, запускающего команду (в примере root). Секреты не записываются в
репозиторий, параметры команды или журналы. Сборка требует доступов к registry/npm/Go
и достаточных CPU/RAM; на общем velette выбирать спокойное окно.

После ревью из checkout с этим PR:

```sh
sudo install -d -m 0755 /usr/local/lib/choral-deploy
sudo install -m 0644 scripts/deploy.py scripts/frontend-delivery.py \
  scripts/frontend-release.py scripts/ci.py scripts/check-deploy-song.py \
  /usr/local/lib/choral-deploy/
sudo install -m 0755 deploy/choral-deploy /usr/local/bin/choral-deploy
sudo install -d -m 0700 /var/lib/choral-deploy
# backup root должен быть существующим штатным каталогом 0700.
sudo install -m 0600 deploy/choral-deploy.example.json /etc/choral-deploy.json
# Заполнить конфигурацию приватно; пример сам по себе запускать нельзя.
sudoedit /etc/choral-deploy.json
```

В конфигурации проверить checkout/project, публичный origin, Docker data-root,
свободный `candidate_port`, общий lock, backup/mirror paths и backend commit.
`minimum_free_bytes` — минимальный запас на каждой из FS state/backup/Docker,
по умолчанию в примере 10 GiB; увеличить по объёму данных/образов. Это порог,
а не точный прогноз размера сборки и backup. Требуется также 10 000 свободных inode.
Не менять пути/проект, чтобы обойти отказ проверки установленного состояния.

Для frontend режима нужен уже выполненный переход из
[frontend-deployment.md](frontend-deployment.md#однократный-переход-compose).
Full поддерживает и встроенный, и внешний frontend. Изменения Compose, deployment
config и критичных backup/runtime helpers относительно установленной версии
намеренно требуют отдельной установки. Начальная установка #80 также выполняется
отдельно; регулярный deploy не обновляет собственные root-owned helpers.

### Контрольная песня

Один раз выбрать отдельную небольшую техническую опубликованную песню с постоянной
гостевой ссылкой. Не использовать оригиналы/пароли преподавателей. Приватный файл
из `song_fixture` должен иметь режим 0600 и поля:

```json
{
  "token": "<43-character-share-token>",
  "song_id": "<song-uuid>",
  "track_id": "<ready-track-uuid>",
  "media_sha256": "<SHA-256 полного playback файла>",
  "peaks_sha256": "<SHA-256 ответа peaks>"
}
```

Получить ID, token и исходные checksum из заведомо исправной технической песни.
Сверить отдельно от кандидата: скрипт никогда не принимает новые checksum
автоматически. Техническую песню и её ссылку сохранять между выпусками; при
намеренном изменении обновить fixture после проверки. Вначале проверить её против
текущего сервера:

```sh
sudo python3 /usr/local/lib/choral-deploy/check-deploy-song.py \
  --fixture /etc/choral-deploy-song.json --origin http://127.0.0.1:8080
```

Проверка выполняет только GET, не следует redirect, сверяет song/track IDs,
полные media/peaks checksum и первые 16 bytes через Range. URL с token не печатает.
Временный порт доступен только локально, как и основной upstream. После выпуска
вход, прослушивание и ранее открытая вкладка остаются ручной browser-приёмкой.

## Ошибки и восстановление

Журнал `/var/lib/choral-deploy/<timestamp>-<SHA>/result.json` содержит стадии,
версии, checksum, backup path и CI URL. `.env` сохранён в приватном `env.before`.
`active.json` блокирует повторный выпуск после незавершённой операции, в том числе
после SIGKILL/перезагрузки. Старые release directories, images и backup не чистятся
автоматически. Все ручные publish/rollback/restore также выполнять под общим lock.

- Ошибка сборки/CI до `prepared`: приложение не менялось, можно исправить причину
  и повторить команду. Незавершённые подготовительные каталоги остаются приватными.
- `old_backend_resumed`: новая версия ещё не запускалась; старый контейнер и
  frontend возвращены. После исправления причины сверить checkout с прежним
  commit (fast-forward мог уже произойти), `.env`, image и health. Git автоматически
  назад не перематывается, незавершённый журнал сохраняется.
- `starting_backend`, `opening_traffic`, `needs_recovery`: запуск нового backend
  мог изменить схему. Команда останавливает candidate/app при обрабатываемой ошибке;
  после аварийного завершения проверить и остановить указанный в журнале candidate
  вручную. **Не запускать старый image на этом volume.** Либо исправить новый релиз,
  либо восстановить старый image + backup в отдельный пустой volume по
  [runbook](operations.md#восстановление-в-чистый-volume). Это отдельная операция;
  принятые после snapshot данные при восстановлении не сохраняются автоматически.

После ручной приёмки восстановленного состояния архивировать `active.json` в
каталог неудачного выпуска под тем же maintenance lock, сохранив `result.json`.
Просто удалять блокировку и повторять deploy без восстановления нельзя.
Автоматический откат БД и универсальная кнопка backend rollback не реализованы.
Frontend отдельно откатывается штатным `frontend-release.py rollback` под lock.

## Проверки

```sh
python3 scripts/check-deploy.py
# Опционально: только существующий runtime image; отдельные project/volume/ports.
sudo python3 scripts/check-deploy-container.py --image sha256:<runtime-image-id>
sudo python3 scripts/check-deploy-container.py --image sha256:<runtime-image-id> --failure smoke
sudo python3 scripts/check-deploy-container.py --image sha256:<runtime-image-id> --external
```

Unit/adapter checks проверяют CI admission, lock, сохранение env/volume, порядок
backup/start/smoke и ошибки до/после запуска, frontend rollback. Docker-проверка
создаёт пустую отдельную БД, использует существующий runtime image без сборки,
проверяет реальный backup, candidate-порт, replace app и HTTP. CI admission и
контрольная песня в этом Docker fixture заменены тестовыми адаптерами; отдельный
HTTP-тест проверяет song checker. Это не проверка production credentials,
полноценной миграции между двумя версиями приложения или физического браузера.

Локально 9 ноября 2026 прошли 11 unittest methods с вариантами ошибок, четыре
проверки существующего CI selector/admission, syntax/config/link checks и
`git diff --check`. На Docker проверены три изолированных сценария: успешный full
со встроенным frontend, намеренная ошибка smoke после запуска кандидата, успешный
full с внешним frontend и его snapshot. Все временные проекты/volumes/теги удалены.
Использовался существующий runtime image; новая Dockerfile-сборка, реальный CI fetch
и production deployment этими тестами не выполнялись.
