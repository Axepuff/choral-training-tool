# Каркас backend (Issue #3)

Frontend остаётся в корне и сохраняет согласованный дизайн. Go-сервис обслуживает `GET /livez`, `GET /readyz` и auth endpoints Issue #4
и songs endpoints Issue #5 (описаны ниже); storage и worker реализуются следующими задачами.
Не реализованные URL возвращают 404 без мок-успеха.
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

## Авторизация (Issue #4)

Сервер теперь подключает реальные `POST /api/v1/auth/login`, `GET /api/v1/auth/me`,
`POST /api/v1/auth/logout`, `PUT /api/v1/auth/password` и
`PUT /api/v1/admin/users/{userId}/password`. CRUD аккаунтов/UI остаются #13;
первоначальный teacher создаётся оператором. Frontend подключается отдельно в #9.
Пакеты: `internal/auth`, `internal/users`. Таблицы users/sessions из foundation
используются без изменения; новая миграция **0002_auth.sql** принадлежит #4 и
добавляет только устойчивый limiter и индекс sessions. Следующим миграциям нужен
следующий свободный номер. Принятый `0001_initial.sql` не изменён.

Для production задайте `CHORAL_ORIGIN=https://ваш-домен` (без пути и конечного `/`).
По умолчанию `https://localhost`. Origin сравнивается с конфигурацией, а не с Host
или `X-Forwarded-*`; CORS не включён. TLS может завершаться на доверенном proxy.
Для HTTP **только локально** нужны одновременно:

```sh
export CHORAL_ADDR=127.0.0.1:8080
export CHORAL_ORIGIN=http://127.0.0.1:8080
export CHORAL_LOCAL_HTTP=true
```

Сервер откажет при нелокальном listener или нелокальном HTTP origin. Local-cookie
называется `choral_session_local` и только в этом режиме не имеет Secure;
production-cookie `__Host-choral_session` всегда Secure/HttpOnly/SameSite=Lax/Path=/,
без Domain. Флаг local нельзя включать на опубликованном сервере.

Сессии имеют абсолютный срок 7 суток без продления. Cookie ID — случайные 32 байта;
в SQLite только SHA-256. CSRF вычисляется HMAC-SHA256 от cookie ID с меткой
`choral-csrf-v1`, в БД только его hash: `/auth/me` восстанавливает тот же токен без
хранения открытого секрета. Login ротирует предъявленную сессию транзакционно;
смена/сброс пароля отзывает все сессии и требует нового входа (204). Все аккаунты,
созданные CLI, требуют смены временного пароля. До смены доступны только me,
password, logout. При обязательной смене новый пароль должен отличаться от текущего
временного: совпадение возвращает 422 validation_error, сохраняя флаг обязательной
смены и все сессии без изменений. Успешная смена на другой пароль отзывает все
сессии. Неверные/заблокированные учётные данные дают одинаковый 401.
После пяти неуспешных входов IP/email блокируется на 15 минут: следующая попытка
получает 429 с Retry-After. Лимит сохраняется после рестарта; успех сбрасывает
счётчик пары. IP берётся из RemoteAddr, proxy-заголовкам сервер не доверяет.
За proxy все клиенты могут иметь один IP; это консервативное ограничение для MVP.
Истёкшие limiter-записи очищаются при следующих попытках входа.

Argon2id: 64 MiB, 3 прохода, parallelism 1, соль 16 байт, hash 32 байта;
`x/crypto` нужен для Argon2id, `x/text` — для NFC email. Email приводится к NFC,
trim + lower-case всего адреса; пароль не нормализуется и не обрезается,
12–128 Unicode scalar values. HTTP JSON ограничен 8 KiB, неизвестные поля,
невалидный UTF-8 и одиночные surrogate отвергаются. Логи не содержат URL, тела,
email, паролей, cookie и CSRF.

### Локальные команды оператора

```sh
cd backend
go build -o /tmp/choral-accounts ./cmd/accounts
# CHORAL_DATA_DIR должен указывать на тот же каталог, что у сервера.
# В Bash: ввод без эха, пароль не попадает в argv или историю команд.
IFS= read -r -s -p 'Временный пароль: ' choral_password
printf '%s\n' "$choral_password" | /tmp/choral-accounts bootstrap admin@example.test
unset choral_password
```

Для начального учителя повторите защищённый ввод и замените последнюю команду на
`/tmp/choral-accounts create-teacher teacher@example.test`. Bootstrap допускается
только при полностью пустой users; повторный вызов ничего не меняет. Создание
teacher требует существования активного admin. При потере доступа к единственному
admin используйте `/tmp/choral-accounts reset-admin` с тем же защищённым stdin:
пароль заменяется, сессии отзываются, блокировка снимается, нужна смена при входе.
При нескольких admin команда отказывается выбирать аккаунт. Прямое чтение с
терминала запрещено во избежание эха; stdin принимает pipe или файл без прав
группы/остальных (0600). Не используйте литералы настоящих паролей в shell-командах,
Git, URL или env. Удаляется ровно один завершающий LF/CRLF транспорта.
Передавайте временный пароль адресату по отдельному защищённому каналу.

### Контракт для следующих backend-пакетов

`auth.Service` реализует `platform.IdentityProvider` и `platform.Authorizer`.
Сначала вызывайте `Authenticate(ctx, request)`, затем нужный `Can*`; роль/owner из
JSON/query не являются identity. `ErrUnauthorized` означает 401, `ErrCSRF` —
403 csrf_failed, `ErrPasswordChange` — 403 password_change_required. Ошибки БД
не должны превращаться в успех. Authorizer повторно проверяет актуальную роль,
сессию, блокировку, срок и обязательную смену пароля; подмена Role в Identity
не расширяет доступ. ShareGrant должен поступать только из проверенного sharing
пакета (#6), публичные endpoints не должны расширять grant через cookie identity.
Для media дополнительно проверяйте ready, даже если admin может читать метаданные.
Не вызывайте DB-based authorizer внутри уже открытой транзакции этого же пула
(один connection); проверяйте identity до неё, а изменяемые инварианты — внутри.
`users.SetPassword` принимает транзакцию вызывающего API для атомарного отзыва;
`users.SetBlocked` блокирует и отзывает сессии атомарно, защищая последнего admin.
HTTP CRUD/смена ролей и UI аккаунтов не входят в эту задачу.

### Поведенческие проверки #4

```sh
cd backend
go test ./...
go test -race ./...
go vet ./...
go build -o /tmp/choral-server ./cmd/server
go build -o /tmp/choral-accounts ./cmd/accounts
```

Тесты используют временные SQLite и вымышленные секреты: вход/единая ошибка,
постоянный limiter после закрытия/открытия БД, CSRF/Origin, cookie, ротация,
logout/expiry/revocation, блокировка, роль/owner/share scope, смена временного
пароля, reset admin, конкурентный и повторный bootstrap, операторские команды,
Unicode и отсутствие секретов в HTTP-логах. Проверка схемы foundation также
проверяет применение двух миграций и повторное открытие базы.

Проверено в локальной среде Issue #4: `go test ./...`, `go test -race ./...`,
`go vet ./...`, `go mod verify`, сборка обоих CLI/server binary; запуск binary
с временной БД и цепочка bootstrap → teacher → login/me → password → новый
login → logout. Также прошли `npm ci`, typecheck, lint, build, build-storybook,
`node scripts/assemble-pages.mjs`. Браузерные play-проверки не запускались:
frontend-код и дизайн в #4 не менялись.

## Песни и дорожки (Issue #5)

`internal/songs` подключён в server к реальным auth IdentityProvider/Authorizer.
CRUD, поиск и сортировка сохраняются в SQLite, транзакции защищены версией
`If-Match: "N"`; отсутствие заголовка — 428, конфликт — 409. JSON creation
требует UUIDv4 `Idempotency-Key`, Origin и X-CSRF-Token реальной сессии.
Полный формат запросов/ответов — [OpenAPI](api/openapi.yaml), подробности
пагинации, валидации и удаления — [контракт songs](api/README.md#реализация-songs-в-issue-5).

Новая миграция `0003_songs.sql` перестраивает граф tracks/assets/jobs без отключения FK,
сохраняет существующие строки и связи,
добавляет tracks.deleted_at и уникальность live-позиции. Принятые миграции
0001/0002 не меняются. Удалённые записи/файлы остаются для media grace period;
очистка на диске относится к #8. Не очищайте оригиналы вручную при ошибке.

При старте сервер создаёт в каталоге данных локальный случайный ключ
`song-responses.key` (0600) для AES-GCM replay и подписей cursor. Это секрет
приложения вне БД: храните на постоянном томе, не добавляйте в Git, не публикуйте
и включайте в защищённую резервную копию. Потеря/замена ключа лишает возможности
расшифровать ещё действующие replay (503); такие запросы не создают дубликат.
Неверная длина/недоступность файла останавливает startup. Автоматической ротации
нет; сохраняйте ключ как минимум до истечения replay 24 ч и cursor 15 минут.
Ключ создаётся приложением; чтение сторонних credentials не требуется.

Проверки:

```sh
cd backend
go test ./...
go test -race ./...
go vet ./...
go mod verify
go build -o /tmp/choral-server ./cmd/server
go build -o /tmp/choral-accounts ./cmd/accounts
```

Поведенческие тесты используют реальные временные SQLite, Argon2id login,
cookie/CSRF и HTTP handler. Проверены CRUD после закрытия/открытия DB и сервисов,
teacher/owner/other/admin/anonymous, подмена song/track ID, публикация, Unicode,
границы 1–32 дорожек, перестановка и добавление ID, SQL failure rollback,
конкурентный If-Match, encrypted idempotency/restart/expiry, снимок списка после
редактирования/удаления/снятия публикации, поиск/сортировка, cursor scope/signature/
expiry, отзыв сессии и связи медиа/jobs/shares. Отдельно проверено обновление
заполненной схемы #3/#4 с pending asset/job и FK, повтор миграций.
Frontend и дизайн не изменены; подключение формы/списка — #10.

Фактическая проверка Issue #5: Go 1.27.3 из `/tmp/choral-toolchain`,
`go test ./...`, `go test -race ./...`, `go vet ./...`, `go mod verify`, сборки
server/accounts. Собранный server проверен по HTTP: bootstrap вымышленного
аккаунта → login → смена временного пароля → новый login → создание песни →
SIGTERM (exit 0) → новый процесс с тем же томом/сессией → чтение прежних данных →
редактирование → удаление/404. Frontend: `npm ci`, typecheck, lint, build,
build-storybook, assemble-pages прошли; браузерные play-проверки не запускались,
поскольку UI не изменён. Обновлённый YAML OpenAPI прочитан YAML-парсером;
это не полный OpenAPI validator. Ветка, настройки Git/агента/очереди не менялись;
commit/push/PR/merge не выполнялись.
