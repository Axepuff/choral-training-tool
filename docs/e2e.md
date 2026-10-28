# Сквозная приёмка — Issue #15

Runtime уже использует Go/SQLite/FFmpeg и Web Audio. Разделы handoff об отсутствии
backend — исторический срез; актуальные реализации описаны в дополнениях #4–14.
Дизайн, production code и правила очереди эта задача не меняет.

## Локальное воспроизведение CI

Нужны Node 24, Go из `backend/go.mod`, Chrome с AAC/WebCodecs, FFmpeg и FFprobe
и sqlite3 CLI в PATH (для backup/restore). Системный Go может оказаться старее требуемого: проверять `go version`.
Auth browser suite также проверяет явную Pages demo сборку. Команды `test:e2e`
и `test:auth:browser` сами вызывают `build:e2e`: runtime с `VITE_APP_DEMO=false`
в `dist/e2e-runtime`, demo с `VITE_APP_DEMO=true` в `dist/e2e-demo/app`.
Они не зависят от содержимого `dist/index.html` или `storybook-static/app`
и не требуют предварительной сборки Storybook/Pages. Никакие аккаунты production, API-ключи, внешний сервис или Docker не нужны.

```sh
npm ci --cache /tmp/choral-npm-cache --no-audit --no-fund
npm run typecheck
npm run lint
npm run test:auth
npm run test:audio
npm run test:audio:browser
npm run build
npm run build-storybook
node scripts/assemble-pages.mjs
npm run test:stories
npm run test:e2e
cd backend
go mod verify
go test -count=1 ./...
go vet ./...
go build -o /tmp/choral-server ./cmd/server
```

Команды выполнять последовательно, останавливаясь при первом ненулевом статусе.
`CHROME_BIN` выбирает Chrome для stories/auth/songs; audio runner использует
`CHORAL_CHROME_BIN`. Go browser tests включены через `CHORAL_BROWSER_TEST=true`
в `test:e2e`, `-count=1` исключает cached success. `-p=1` последовательно запускает auth/songs. Fixture выбирает временный
порт и передаёт одинаковый origin серверной auth и браузеру через `CHORAL_TEST_WEB`.
Собранный runtime и API отдаёт существующий production `platform.NewService` на
одном origin, с реальными headers/лимитами тела и static serving. В harness нет
Vite dev server или самодельного API proxy. Storybook и изолированный Pages demo
обслуживаются статическими Node HTTP servers. Сквозная приёмка проверяет production assets без HMR.
Browser suite имеет общий Go timeout и таймауты ожиданий.

`test:stories` читает **все** entries типа story из собранного `index.json`, открывает
каждую в отдельной новой вкладке Chrome и ждёт `storyFinished` со статусом success. Ошибки render/play и
таймауты завершают процесс ненулевым статусом. Число завершённых stories сверяется
с обнаруженным индексом и печатается, число 34 не закреплено. Play выполняет сам
Storybook, включая assertions из `storybook/test`; build не считается проверкой play.
Runner использует Node HTTP/WebSocket и Chrome DevTools Protocol, как существующие
browser tests: новых npm-зависимостей не требуется. После изменения stories нужна
новая сборка. Устаревшие selectors и ожидания в stories исправляются, не пропускаются.

CI `frontend` запускает audio и все stories, `backend` — полный Go suite,
`e2e` — настоящий HTTP/SQLite/FS/FFprobe/FFmpeg worker и собранный frontend через один browser origin.
Аккаунты создаются через тот же users service, что CLI, во временной БД;
административный UI #13 не нужен. Это application integration, а не проверка
размещения reverse proxy/TLS: контейнерный smoke и restore описаны в operations.md.

## Карта поведенческих доказательств

| Контракт / возможная регрессия | Исполняемая проверка |
| --- | --- |
| Login, cookies/reload/logout, password gate, blocked session | `auth.TestFrontendBrowser`, `tests/auth-browser.mjs` |
| Create → upload → настоящий ready → edit/reload → guest song/list | `songs.TestSongsFrontendBrowser`, `tests/songs-browser.mjs` |
| Teacher-owner, teacher-other, admin, anonymous; подмена role/ID | browser flow и `songs.TestCRUDRestartConflictOwnership` |
| Wrong-scope/revoked token, public write, отсутствие выдачи originals | `sharing.TestScopesRevocationRotationAndMedia`; guest browser requests |
| SQLite/replay после повторного открытия | `songs.TestIdempotencyRestartAndConcurrentEdits`, sharing scope test |
| SIGKILL worker/restart при конвертации | `processing.TestKillRestartDuringConversion` |
| Ошибка processing/commit/диска сохраняет source и старый playback | `processing.TestFailuresKeepOriginalAndOldAsset`, `TestResultProbeTimeoutKeepsOriginal` |
| Удаление source только после готового результата | `processing.TestRealFormatsAndArtifacts`, `TestCompletionOrderAndCleanupRetry` |
| Реальное public media decode/play/pause/seek | guest browser flow с результатом настоящего worker |
| Точная смесь PCM, loop/seek/solo/mute/clock, отказ загрузки | `test:audio`, `test:audio:browser` (настоящий AAC, синтетический HTTP fixture) |
| Loading/error/empty, поиск, сохранение, responsive UI | все Storybook stories/play и browser suites |

Повторные проверки на разных слоях имеют разный смысл: Go защищает authorization,
транзакции и файлы, browser — интеграцию с cookies/формами/worker и видимость прав,
audio fixture — независимый PCM oracle и контролируемые сетевые/decoder failures.
Browser fixture создаёт настоящий File из детерминированных байтов через
DataTransfer/change: Linux CDP filesystem chooser не всегда отправлял change для
длинного Unicode-пути (подтверждено capture listener). Это не проверка нативного
диалога ОС; upload/probe/worker обрабатывают реальные байты. Нативный chooser
проверять вручную на устройствах. Fixtures генерируют небольшие WAV и другие
форматы во временных каталогах; длинный
AAC для оконного transport создаётся из синусоиды, исходное пользовательское аудио
в Git не добавляется. Audio fixture не доказывает серверную авторизацию; её проверяет
реальный сервер. Auth fixture ready metadata используется только для auth/layout;
full songs flow не фабрикует готовность обработки.

## Секреты и результаты

CI не получает production secrets. Сохраняются обычные текстовые статусы/assertions,
имена тестов и discovered/completed count. Не загружаются screenshots, HAR, traces,
SQLite, media, browser profile, cookies, response bodies или публичные URL/токены.
Из songs failure удалён dump всей страницы со ссылкой. Story runner сообщает только
ID/status событий; временный Chrome profile удаляется в finally. Не добавлять
`continue-on-error`, retries или flaky skip для маскировки поломок.

## Матрица ручной проверки перед размещением

Автоматическая эмуляция размеров не заменяет устройство или оценку слышимого звука.
В каждой строке пройти login/create/upload/ready/edit/reload, затем чистым гостем
song/list, play/pause/seek, границу loop, метроном, Solo/Mute и внутренний свайп.

| Браузер / размер | Автоматизация | Ручная проверка |
| --- | --- | --- |
| Linux Chrome 320×640, 360×800 | auth/songs/audio layout, overflow, controls | слушать стыки/синхронность на целевом устройстве |
| Linux Chrome 800×360 | landscape и внутренние scroll regions | поворот во время playback |
| Linux Chrome 1280×900 | desktop layout/transport | клавиатура и слышимый микс |
| Физический Safari iOS, portrait/landscape | не выполнено в Linux CI | gesture unlock, AAC, фон/возврат, seek/loop, свайп |
| Физический Chrome Android, portrait/landscape | не выполнено в Linux CI | gesture unlock, AAC, фон/возврат, seek/loop, свайп |

Длинные имена партий находятся внутри горизонтально прокручиваемого микшера;
проверка отсутствия общего overflow не требует вместить весь микшер в экран.
Production HTTPS/Secure cookie, reverse proxy limits, реальный volume и clean restore
проверяются отдельно по operations.md. Запуск GitHub Actions контроллером после
публикации остаётся обязательным: локальный прогон не является remote CI run.

## Изменения проверок и границы доказательств

| Место | Решение | Причина и остающееся доказательство |
| --- | --- | --- |
| Go songs/sharing/processing suites | сохранить | права, reopen SQLite, SIGKILL и сохранность файлов проверяются через их владельцев; browser не заменяет эти проверки |
| SongLibrary play | исправить ввод | native value setter + input event проверяют фильтр/сохранение в React; userEvent ввод оставлял DOM value без обновления controlled state |
| TrackControls play | исправить ожидание | updateArgs асинхронен; ждём observable aria/value. Synthetic keyboard не исполняет native range default action: input event проверяет изменение громкости |
| TrackControls callback spies после updateArgs | убрать дублирование | после updateArgs старый spy не сохранял историю вызова при успешном UI-переходе; сохранены UI assertions переходов S/M/volume и disabled negative callback assertion |
| Auth browser embedded plays | объединить | все те же page-story ID/play выполняет `tests/e2e/storybook.mjs`; auth сохраняет независимые runtime и Pages demo проверки |
| Auth browser layout | исправить selectors | плеер теперь содержит реальный микшер вместо прежнего списка; длинные имена находятся внутри scroll region |
| Songs browser | усилить | дождаться доступности редактора/выбора файла/нового сохранения, публичные write/scope failures, playback настоящего worker output |

Клавиатурное управление loop проверяется отдельным audio browser suite; Storybook
range input assertion не выдаётся за native keyboard test. Первый запуск нового
runner выявлял реальные ненулевые failures старых play; они не были скрыты skip.


## Локальный результат 28 октября 2026

База изменений: `6544d9d`; Node 24.19.0, Go 1.27.3, Chrome 147.0.7727.116,
FFmpeg/FFprobe 6.1.1, sqlite3 3.45.1. Новых npm-зависимостей нет.

- `npm ci`, typecheck/lint, runtime/demo build, Storybook build и assemble прошли.
- Node: auth **15**, audio/MP4 **55**, существующие queue checks **44** — без failures/skip.
- Audio browser regressions прошли, включая PCM oracle, loop/метроном, seek,
  Solo/Mute, ошибки декодирования/сети и четыре размера.
- Полный Go suite: **158 pass** (включая subtests), **0 fail**. Два opt-in browser
  теста исключены обычным запуском и отдельно выполнены через `test:e2e` — **2 pass**.
  Backup/clean restore выполнен с настоящим sqlite3, без skip отсутствующей утилиты.
- Все **45/45** обнаруженных stories завершились с success вместе с play.
  Встроенный повтор 30 page-stories в auth suite заменён общим runner, который
  включает все те же ID и play; Pages demo smoke сохранён в auth. Новая вкладка на каждый case
  изолирует preview/render lifecycle; повторного запуска упавших cases нет.
- Go mod verify/vet/build и whitespace check прошли.

Это локальные результаты, а не опубликованный GitHub Actions run. Контроллер
должен выполнить remote CI после публикации; физические iOS/Android и production
HTTPS/hosting в этой среде не проверялись. Матрица выше сохраняет эти ограничения.


## Исправление повторного прогона Issue #15

Причина `Pages demo did not load`: auth smoke читал `storybook-static/app`,
куда assemble копировал последнюю обычную runtime-сборку. Успех зависел от
предварительного ручного `VITE_APP_DEMO=true npm run build`.
Теперь обе browser-команды сами собирают runtime и явно помеченную demo
в отдельные каталоги через общий `build:e2e`; smoke по-прежнему проверяет
заголовок демонстрации и отказ фиктивного входа от настоящей авторизации.
E2E job больше не строит неиспользуемый Storybook; все его play по-прежнему
выполняются в frontend job. Production frontend и согласованный дизайн не менялись.

Проверка исправления 28 октября 2026:

- `npm run test:e2e`: **2/2 pass**, включая Pages demo smoke.
- Повтор исходной последовательности `npm run build` → `npm run build-storybook`
  → `node scripts/assemble-pages.mjs` → `npm run test:e2e`: **2/2 pass**.
- Typecheck/lint, auth **15/15**, audio/MP4 **55/55**, audio browser прошли.
- Storybook runner: **45/45** обнаруженных stories вместе с play прошли.
- `go test -count=1 ./...`, vet, mod verify и build прошли. Обычный Go suite
  не включает два opt-in browser tests; они выполнены указанной e2e-командой.
  В системном PATH нет sqlite3, поэтому backup/restore отдельно выполнен с
  `/tmp/issue14-sqlite/usr/bin` в PATH: `TestBackupCleanRestore` прошёл без skip.
- `git diff --check` прошёл. Remote CI и физические iOS/Android остаются
  проверками владельца/контроллера; локальный результат их не подменяет.
