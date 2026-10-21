# Каркас backend (Issue #3)

Frontend остаётся в корне и сохраняет согласованный дизайн. Go-сервис пока
обслуживает только `GET /livez` и `GET /readyz`; остальные URL возвращают 404,
без мок-успеха. Login, songs, storage и worker реализуются следующими задачами.
Pages публикует только статический UI и не запускает backend.

## Toolchain и запуск

Закреплены Go **1.27.3** (`backend/go.mod`, CI читает этот файл) и pure-Go
`modernc.org/sqlite` **1.39.1**; CGO не требуется. Все суммы модулей в `go.sum`.
Установленный `/usr/bin/go` в этой локальной среде фактически оказался рабочим
Go 1.22.2 — это расхождение с исторической записью handoff, но для проекта он устарел.

Воспроизводимый setup Linux amd64 без root (каталог установки можно заменить):

```sh
curl -fL https://go.dev/dl/go1.27.3.linux-amd64.tar.gz -o /tmp/choral-go.tar.gz
echo '65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40  /tmp/choral-go.tar.gz' | sha256sum -c -
mkdir -p /tmp/choral-toolchain
tar -C /tmp/choral-toolchain -xzf /tmp/choral-go.tar.gz
export PATH=/tmp/choral-toolchain/go/bin:$PATH
export GOCACHE=/tmp/choral-gocache GOPATH=/tmp/choral-gopath
go version
go env GOVERSION GOOS GOARCH
cd backend
go mod download
go mod verify
go test ./...
go vet ./...
go build -o /tmp/choral-server ./cmd/server
export CHORAL_ADDR=127.0.0.1:8080
export CHORAL_DATA_DIR=/tmp/choral-dev-data
export CHORAL_SHUTDOWN_TIMEOUT=15s
/tmp/choral-server
```

Для постоянной установки используйте доступный постоянный каталог вместо `/tmp`.
Данные SQLite (`choral.sqlite`, WAL/SHM) должны находиться на постоянном локальном
томе; `/tmp/choral-dev-data` годится только для проверки. Не помещайте данные в Git.
Пример env без секретов: `backend/.env.example`; dotenv автоматически не читается.
Неверные env приводят к выходу с кодом 1. Default: `127.0.0.1:8080`, `./data`, `15s`.
Shutdown timeout положительный, максимум 1m. В production HTTPS обеспечивает proxy.

В другом терминале на той же машине:

```sh
curl --fail http://127.0.0.1:8080/livez
curl --fail http://127.0.0.1:8080/readyz
# SIGTERM или Ctrl+C: сервер закрывает listener и завершает активные запросы.
```

Readiness делает SQLite ping с timeout 1s; 503 при недоступной БД/остановке.
Невозможность открыть или мигрировать БД при старте завершает процесс до listen.
Liveness не зависит от БД. HTTP: headers 16 KiB/5s, чтение и запись 30s,
idle 60s, верхняя граница тела 101 MiB (multipart overhead для файла 100 MiB).
Upload-задача должна дополнительно ограничить сам файл и streaming-время.
Структурированные JSON-логи содержат события, request ID и длительность;
URL/query, cookie, заголовки, тела, env и тексты ошибок БД не записываются.
`X-Request-Id` генерируется сервером, `Referrer-Policy: no-referrer`.

## SQLite и миграции

Один connection/writer, WAL, `foreign_keys=ON`, `busy_timeout=5000` на каждом
новом соединении. SQL-файлы встроены в бинарник. Каждый файл и запись версии
фиксируются одной транзакцией с `BEGIN IMMEDIATE`; сбой откатывает оба.
Пустая база создаётся автоматически. Повторный запуск проверяет SHA-256 уже
применённых файлов. Неизвестная версия/изменённая миграция запрещают запуск.
Перед обновлением нужно резервное копирование; автоматического down нет.

Следующий агент добавляет `NNNN_description.sql` со следующим свободным номером
в `backend/migrations/`. Не редактировать принятые миграции. Номер резервируется
в описании задачи/PR; при коллизии более поздний PR перенумеровывает только ещё
не принятый файл после обновления от main. Порядок лексикографический; нельзя
вставлять миграцию перед уже принятой. SQL без собственных BEGIN/COMMIT и без
внешних файловых побочных эффектов. Проверять пустую базу, обновление существующей
и повторный запуск. Миграции применяет сервер до приёма HTTP-запросов.

Начальная схема содержит сущности контракта #2, FK, уникальность и локальные CHECK.
Для asset в `ready` обязательны ненулевые playback/peaks paths, положительная
`duration_ms`, `mime=audio/mp4`, `sample_rate=48000`, `channels=1`. CHECK явно
отклоняет NULL метаданных при INSERT и UPDATE; в processing они могут отсутствовать.
Это исправление первоначальной миграции в ещё не принятой реализации #3:
локальную тестовую БД предыдущего прохода нужно пересоздать в новом каталоге,
поскольку проверка checksum намеренно отклонит изменённый файл миграции.
Составные бизнес-инварианты (публикация всех готовых дорожек, принадлежность assets,
последний admin) должны проверять соседние пакеты в транзакциях; наличие таблиц
не означает готовность этих функций.

## Границы пакетов

`backend/internal/platform/contracts.go` закрепляет Identity/Resource/ShareGrant
и Authorizer из API-контракта, IdentityProvider, Storage и Jobs. Реализаций,
возвращающих фиктивный успех, нет. IdentityProvider проверяет серверную сессию;
Authorizer получает уже проверенные identity/share, а не JSON роль клиента.
Storage принимает только внутренние ключи, Stage ограничивает байты, Publish
делает fsync/атомарный rename на одном томе; ошибки возвращаются вызывающему коду.
Jobs.Enqueue и Complete используют транзакцию вызывающего кода, чтобы ресурс,
задание и публикация не расходились. Claim должен атомарно восстанавливать lease
и соблюдать ограничения #2; отсутствие работы — `(nil, nil)`. Complete получает
job ID, конечное состояние и стабильный error code. Детали worker относятся к #8.

## FFmpeg и облако

FFmpeg не нужен для health/SQLite и проверяется отдельно:

```sh
command -v ffmpeg
ffmpeg -version
command -v ffprobe
ffprobe -version
```

В текущей среде обнаружены оба binary **6.1.1-3ubuntu5**, что не соответствует
worker baseline **7.1.x** из ADR. Это не проверенная media-среда: #8 должен закрепить
7.1.x и проверить encoder/decoder перед запуском обработки. Каркас не запускает
конвертацию и не объявляет её готовой. Cloud setup/config инструмент в текущей
сессии не предоставлен; настройки агента/очереди не менялись. Приведённый setup
проверен в доступном каталоге без root, ключей и платных сервисов.

PR checks проверяет frontend целиком и Go test/vet/build; Pages workflow сохранён.
Поведенческие Go-тесты проверяют пустую БД, повтор миграций, persistence, FK после
reconnect, rollback, повреждение БД, readiness, редактирование миграции,
отсутствие секретов в логах и завершение активного HTTP-запроса при shutdown.

## Проверки этой реализации

В доступной sandbox выполнены `go version`/`go env` для установленного Go 1.27.3,
`go mod verify`, `go test ./...`, `go test -race ./...`, `go vet ./...`, build бинарника; frontend
`npm ci`, typecheck, lint, build, build-storybook и assemble-pages.
Бинарник отдельно запущен на пустой БД, проверен `/readyz`, остановлен SIGTERM
с кодом 0 и повторно запущен с тем же каталогом. UI-код не менялся;
браузерные play-проверки stories здесь не запускались.
