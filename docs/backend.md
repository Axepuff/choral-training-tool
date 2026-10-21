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

## Публичные ссылки и media (Issue #6)

`internal/sharing` подключён в server. Реализованы:

- `GET/POST /api/v1/shares`: свои метаданные ссылок без токенов; admin может
  выбрать `ownerId`. Создание принимает `{kind:"song",songId}` либо
  `{kind:"list",ownerId}`, UUIDv4 `Idempotency-Key`, реальную сессию и CSRF.
- `DELETE /api/v1/shares/{shareId}` отключает одну ссылку; повтор безопасен.
  `POST /api/v1/shares/{shareId}/rotate` меняет токен атомарно и включает также
  отключённую ссылку. Владелец/admin проверяются в транзакции вместе с живой
  сессией и текущей ролью. Удалённую песню нельзя заново открыть ротацией.
- `GET /api/v1/public/shares/{token}`: song возвращает ровно одну published/ready
  песню, list — только published/ready песни своего owner. Один owner может иметь
  несколько независимых ссылок. Снятие публикации, удаление, потеря ready немедленно
  исключают песню; токен не даёт прав на запись. Cookie, даже admin, не расширяет
  public scope. Неизвестный/отозванный/неподходящий токен или чужие ID дают 404.
- Session/public `/songs/{songId}/tracks/{trackId}/media` и `/peaks`: активный
  asset должен принадлежать именно этому live track, track — указанной песне.
  Pending/failed replacement не заслоняет старый ready asset. Нет ready —
  редактору 409, гостю/постороннему 404. Готовый draft доступен owner/admin по
  session endpoint, но не по public URL. Media/peaks используют тот же grant и
  published/ready контракт, что публичная выдача метаданных.

Токен — 32 случайных байта (base64url без padding, 43 символа); в shares только
SHA-256. Создание и AES-256-GCM replay фиксируются вместе. Неизменная ссылка
повторно возвращается 24 часа; после disable/rotate — `409 idempotency_stale`,
другое тело — `409 idempotency_conflict`. После истечения TTL возможна новая
операция. Неверный ciphertext/недоступный ключ — ошибка 503, без создания дубля.
Ключ `share-responses.key` создаётся в data dir с 0600, вне SQLite; общий код
загрузки ключа вынесен в platform без изменения song key/формата replay #5.
Сохраняйте оба key-файла на постоянном томе и в защищённом backup. Ключ sharing
также шифрует cursor; автоматической ротации нет.

List pagination: `limit=1..100` (default 30), неизменяемый снимок ID в SQLite
на 15 минут, порядок `updatedAt DESC, id ASC`, актуальные поля/права на каждой
странице. Новые публикации входят только в новый обход; исчезнувшие из доступа
пропускаются. Cursor зашифрован, связан с маршрутом и точным токеном, ID не
раскрывает. Подмена/другая ссылка — 400, истечение — 410, отзыв — 404 независимо
от существования cursor. Старые снимки очищаются при новом обходе.

Public DTO содержит только поля PublicSong/PublicTrack из OpenAPI: нет owner,
email, версии, jobs, внутренних путей, upload-originals и иных редакторских полей.
Ответы не кешируются (`private, no-store`), включая ошибки Range, и используют
`Referrer-Policy: no-referrer`; session пути добавляют `Vary: Cookie`.
`net/http.ServeContent` обслуживает seek-based GET/HEAD, byte Range/206/416,
Content-Length, Content-Type (`audio/mp4`/`application/json`) и ETag активного
asset. Каждый запрос, включая Range/условный GET/HEAD, сначала авторизуется.
Отзыв предотвращает новые запросы после commit. Уже начавшийся ответ и полученные
браузером байты отозвать нельзя; тест сохраняет прежние байты после отзыва.

### Граница Storage и следующих задач

#6 не реализует загрузчик, файловое хранилище или FFmpeg. Handler принимает
`platform.Storage` и вызывает только `Open` для playback/peaks key из SQLite,
после полной проверки доступа. Путь от клиента не принимается, source_path не
читается, static file server и fallback к оригиналу отсутствуют. Для #7 нужно
передать реальный Storage в `sharing.New` в `cmd/server/main.go`; сейчас там nil,
поэтому попытка чтения ready media при отсутствии адаптера даёт честный 503.
Сами ссылки, отзыв, ротация и публичные метаданные уже работают на реальной БД.
Storage.Open должен возвращать seekable immutable snapshot артефакта, ограничивать
ключи каталогом данных и не допускать выхода через пути/symlink. #8 должен
подтвердить интеграцию с реальными AAC/peaks после атомарной фиксации ready.
До этого тесты используют байтовые fixtures только на границе Storage;
они не подтверждают декодируемость аудио и не запускают FFmpeg.

`url` создания/ротации — относительный frontend URL `/?song=<token>` либо
`/?list=<token>`. Подключение этих URL к API и UI шаринга относится к #10;
существующие макеты не являются реализацией защищённого чтения.

Поведенческие тесты `internal/sharing` используют реальные SQLite, Argon2id login,
cookie/CSRF и общий HTTP router: valid/unknown/revoked/wrong-scope, owner/admin/
посторонний, невозможность расширить public scope через admin-cookie, запись,
подмена song/track/asset ID, неопубликованные/processing/failed/retired/empty,
GET/HEAD/Range/peaks, storage failure, независимость ссылок, restart/replay,
rollback secret persistence, snapshot membership/order/expiry и отзыв между
страницами. Команды Go и frontend остаются теми же, что выше.

Фактически проверено для #6 на Go 1.27.3: `go test ./...`,
`go test -race ./...`, `go vet ./...`, `go mod verify`, сборки server/accounts.
Собранный server на временной БД прошёл HTTP smoke: bootstrap → login → смена
временного пароля → login → создание list-ссылки → идентичный replay → пустой
public список → rotate/старый токен 404 → stale replay 409 → revoke/новый токен
404 → SIGTERM с exit 0. Токены/пароли в отчёт и журналы не выводились.
Также прошли `npm ci`, typecheck, lint, build, build-storybook, assemble-pages и
`git diff --check`. YAML OpenAPI прочитан парсером; полный OpenAPI validator и
браузерные play-проверки не запускались. UI/дизайн не изменены. Новых зависимостей,
миграций, commit/push/merge и изменений настроек Git/агента/очереди нет.

## Загрузка и приватное хранилище (Issue #7)

`internal/uploads` реализует `POST /api/v1/songs/{songId}/tracks/{trackId}/uploads`
и `GET /api/v1/jobs/{jobId}`. Это реальный Go HTTP/SQLite/FS/FFprobe путь, без
подключения frontend и без конвертации в HTTP handler. `internal/storage`
подключён к session/public media handlers вместо nil adapter.

Запрос — ровно одна multipart-часть `file`, с настоящими session/CSRF,
UUIDv4 `Idempotency-Key` и `If-Match: "<version>"`. Имя/расширение не участвуют
в выборе пути или формата; произвольное имя, в том числе traversal, безопасно
игнорируется. Один bounded copy пишет файл на диск и считает SHA-256, без
`ReadAll`/`ParseMultipartForm`. Размер самого файла — 100 MiB, общий multipart
budget — ещё 1 MiB. Лимиты квоты, concurrency и времени уточнены в
[ADR](decisions/0001-mvp-contract.md#уточнение-при-реализации-upload-7).

Ошибки чтения классифицируются одинаково при разборе заголовков первой и
следующей multipart-части и при записи тела файла: timeout/отмена —
`408 upload_timeout`, превышение file/body budget — `413 upload_too_large`.
Некорректная структура multipart остаётся `422 validation_error`, повреждённое
содержимое файла — `422 corrupt_audio`. Сетевые regression-тесты проверяют
задержки до первой части, в её заголовках, внутри файла и при чтении следующей
границы/заголовков, а также overflow заголовков обеих частей. После каждого
отказа проверяются отсутствие файлов/asset/job/replay и успешный повтор с тем же
ключом: квота и admission освобождаются, версия песни сохраняется.

Auth проверяется до чтения тела, затем live-сессия, текущая роль/владелец,
существование song/track и версия повторно проверяются перед фиксацией.
Приватный чужой ресурс даёт 404; известная published/ready песня — 403 на запись.
Admin загружает в любую разрешённую песню, квота принадлежит owner песни.
GET job доступен только owner/admin, в том числе failed probe job; пути и hashes
в DTO не выдаются. Удалённая песня скрывает и её jobs.

FFprobe запускается argv без shell по уже открытому локальному descriptor
(`/proc/self/fd/3`, Linux); вывод ограничен 64 KiB, subprocess deadline — 15 s.
Проверяются наличие первого audio stream, codec/container, decoder, положительная
конечная длительность до 20 минут, sample rate и channels. Видео без audio,
битые файлы, неподдерживаемые codec/container и слишком длинное audio отклоняются.
Это metadata-проверка, полное декодирование ещё выполняет будущий worker.

Файлы лежат в `CHORAL_DATA_DIR/files`, режим новых файлов 0600, каталога 0700.
Ключи плоские: `stage-<uuid>`, `original-<uuid>`, `playback-<uuid>`, `peaks-<uuid>`.
Операции используют `os.Root`: пути не выходят за каталог даже через symlink.
Stage выполняет fsync, Publish делает атомарный hard-link без перезаписи,
удаляет временное имя и fsync каталога перед commit SQLite. Все имена находятся
на одном volume. Storage не является публичным FileServer; media читает только
active ready playback/peaks и дополнительно отвергает original/stage ключи.

Миграция `0004_uploads.sql` добавляет source codec/container и уникальность job
на asset. В одной транзакции записываются asset metadata/state, durable job,
pending asset, новая song version и AES-GCM replay в `idempotency_records`.
Original уже сохранён до commit. Active asset не меняется, даже при failed probe.
Одновременный pending/processing upload той же дорожки даёт `409 pending_upload`.
Failed pending допускает новую загрузку; прежняя запись остаётся для уборщика.
Replay проверяется по SHA-256 байтов файла после auth, до If-Match/pending,
действует 24 часа, возвращает исходные status/body/ETag/Location даже после рестарта.
Имя файла и MIME multipart не являются параметрами обработки. Другие байты с
тем же ключом — `409 idempotency_conflict`. Новый nonce уникален в общей таблице.
Ключ `upload-responses.key` создаётся на volume через существующий ResponseKey,
не выводится в логи и должен сохраняться при backup вместе с остальными keys.

На отмене/ошибке до commit временный файл и неопубликованный original удаляются.
До открытия listener выполняется recovery: удаляются stage и originals без
строки assets; referenced originals, включая failed, сохраняются. Это закрывает
окно crash между filesystem publish и DB commit. Recovery рассчитан на один
процесс сервиса, как и ADR; одновременно запускать два сервера на одном data dir
нельзя. Ошибки удаления не маскируются при startup: запуск останавливается.

Граница #8: читать jobs `queued` и assets `pending`, применять lease/retry и
processing limits ADR, обрабатывать первый audio stream; не менять active asset
до полной проверки playback/peaks и commit. После успешного удаления оригинала
очищать `assets.source_path=''` (source_bytes/hash остаются историческими), чтобы
освободить квоту. Failed originals сохранять до успешной замены/явного удаления;
retired assets и логически удалённые песни/треки убирает grace-period cleaner #8.
В #7 уже очищаются только незавершённые HTTP операции и crash-orphans; worker,
полный decode, публикация новых media и периодический cleaner не имитируются.

Поведенческие тесты генерируют маленькие синтетические fixtures установленным
FFmpeg в `t.TempDir()`, не сохраняют исходное аудио в Git. Покрыты WAV/FLAC/MP3/
Ogg/M4A/AIFF, non-audio/corrupt/too-long, overflow, quota/replay, CSRF, чужой owner,
отзыв сессии/смена версии/удаление во время streaming, отмена и настоящий сетевой
read timeout, занятая песня, traversal, повтор/cleanup/recovery, сохранение active
asset, реальный Storage + public GET/HEAD/Range и отказ выдавать original.
Остальные тесты sharing продолжают проверять области доступа.

Регрессия ревью #7: `TestUploadAndJobAccess` вызывает именно upload/job HTTP
handlers с реальными login-сессиями admin, teacher-владельца и другого teacher.
Владелец успешно загружает реальный WAV и получает queued job; owner/admin читают
job, другой teacher получает 404 как для draft, так и для published/ready песни.
Чужая загрузка даёт соответственно 404/403; анонимный запрос и запрос только с
действующим public token получают 401 для обоих endpoints. Тест подтверждает,
что этот token открывает опубликованную песню через public endpoint. При отказе
upload тело не читается, строки songs/tracks/assets/jobs/idempotency_records и
имена/содержимое файлов не меняются, admission не удерживается. После логического
удаления песни job скрыт с 404 от owner, admin и другого teacher.
После исправления замечания повторно прошли `go test ./...`,
`go test -race ./...`, `go vet ./...`, `go build ./...` и `git diff --check`.
Изменены только backend-тесты и эта документация; frontend/Storybook проверки
в этом проходе не повторялись.

Среда проверки #7: Go 1.27.3 из `/tmp/choral-toolchain`; установленный системный
FFmpeg/FFprobe — **6.1.1**, а не исторические 7.1.5 из handoff. На этой сборке
проверяются fixtures; проверка целевой production-сборки 7.1.x остаётся #8/#14.

Проверки результата #7: `go test ./...`, `go test -race ./...`, `go vet ./...`,
`go build ./...`; из корня — `npm ci --cache /tmp/choral-npm-cache --no-audit --no-fund`,
`npm run typecheck`, `npm run lint`, `npm run build`, `npm run build-storybook`,
`node scripts/assemble-pages.mjs`. OpenAPI YAML и локальные `$ref` разобраны
PyYAML; `git diff --check` проходит. UI не изменялся, браузерные play-проверки
повторно не запускались; сборка Storybook их не заменяет. Storybook сохраняет
предупреждение о размере bundle. Тесты дополнительно проверяют предел двух
одновременных HTTP uploads, rollback после publish при отказе SQLite и отсутствие
FFprobe (503 без asset/job), replay после полного повторного открытия SQLite/FS.

## Обработка аудио (Issue #8)

`internal/processing` подключён к `cmd/server`: после upload recovery, до listener
проверяются `prlimit`, FFmpeg AAC encoder/decoder, PCM float encoder, MP4/float PCM
muxers, фильтры resampling/timestamps и FFprobe. Недоступные инструменты
останавливают запуск (`processing_startup_failed`), queued success не имитируется.
Linux и util-linux `prlimit` теперь обязательны. На одном data dir разрешён один
процесс сервиса. При остановке сервер ждёт оба worker слота до закрытия SQLite/FS.

SQLite claim выполняется транзакционно: не более двух processing jobs и одного
на песню. Дополнительно worker держит слот песни в памяти от claim до возврата
из обработки (после остановки subprocess и уборки временных результатов). Отмена
job/удаление дорожки в SQLite не освобождает этот слот досрочно; ожидающая дорожка
той же песни запускается лишь после выхода предыдущей обработки. Lease — 6 минут, wall timeout всей попытки — 5 минут. Проверка результата
FFprobe имеет отдельный лимит 15 секунд; его превышение даёт
`processing_timeout` с повтором и сохранением original. После рестарта
processing leases сбрасываются до listener, оригиналы сохраняются, попытка
повторяется с новым fencing number (`attempts`). Просроченные leases восстанавливает
также poll. Максимум три попытки (первая и два повтора); временный отказ Storage/
SQLite и timeout повторяется через 5 секунд. Остановка сервиса не выдаётся за
ошибку аудио. Исчерпанная прерванная попытка остаётся failed, original сохраняется.
Удалённая/замещённая pending-ссылка отменяет работу; completion повторно проверяет
song/track tombstones, asset ownership, pending ID, job state и номер попытки.

FFmpeg запускается argv через `prlimit`, без shell и пользовательских путей/имён.
Input/output — заранее открытые Storage descriptors (`/proc/self/fd/3`, `4`).
Разрешены локальные file/pipe protocols и тот же список контейнеров, что в upload;
выбирается первый audio stream. Полное декодирование использует `-xerror`, никаких
успешных обрезок через `-t`/`-fs`. На subprocess: address space 1 GiB, CPU 300 s,
file size 64 MiB, 64 descriptors, decoder/encoder/filter threads=1; max allocation
FFmpeg — 64 MiB. Wall cancellation убивает процесс; Linux parent-death signal
убивает его и при SIGKILL сервиса. Для двух слотов необходимо предусмотреть до
2 GiB виртуального адресного пространства плюс память Go/HTTP. Это ограничение
процессов, а не обещание общего container RSS лимита: container limits — #14.

Playback — AAC-LC, MP4, mono, 48 kHz, 96 kbit/s. Нет нормализации громкости,
обрезки начальной тишины или выравнивания по первой ноте. `asetpts=N/SR/TB`
устанавливает timestamp начала в 0, включая контейнеры с ненулевым start time.
FFprobe проверяет единственный AAC-LC stream, mono/48 kHz, начало 0 и длительность
в пределах 20 минут. До конвертации исходник полностью декодируется в mono/48 kHz
для измерения реальной длины по samples, без доверия к оценке длины контейнера.
Длительность playback должна отличаться от неё не более чем на 20 ms; укороченный
результат даже при exit=0 FFmpeg получает `invalid_result`, original сохраняется.
Playback полностью декодируется ещё раз; peaks — настоящие
min/max float samples по окнам 100 ms, амплитуды ограничены [-1,1]. PCM читается
потоком с ограниченной памятью. MP4 edit list учитывает AAC priming; финальный
padding допускается максимум 20 ms (как требует API-контракт) и не расширяет timeline.
`durationMs` берётся из проверенного playback stream; `points.length` соответствует
`ceil(durationMs/100)`. Короткие дорожки не дополняются до длины песни.

Оба результата fsync + publish выполняются до SQLite commit. В одной транзакции
asset становится ready, переключается active ID, очищается pending, job становится
succeeded, повышается song version. Старый рабочий asset сохраняется до этого
commit, затем становится retired. Ошибка транзакции сохраняет original и старый
active asset; неопубликованный результат удаляется. Stale attempt не публикуется.
Sharing использует существующие защищённые media/peaks endpoints и реальные
Storage keys, включая GET/HEAD/Range и отзыв public grant. Frontend не изменён.

После commit уборщик удаляет ready original и очищает `source_path`, освобождая
квоту. Если удалить не удалось, путь остаётся для следующей попытки. Периодическая
уборка — раз в минуту, максимум 64 assets за проход; также после успеха. Retired
файлы удаляются лишь после 24 часов без active/pending references и queued/processing
jobs. Строки истории остаются. Failed original не истекает по возрасту: он сохраняется
до удаления песни/дорожки либо успешной замены на той же дорожке. Успешная замена
переводит прежние failed assets в retired. Startup recovery из uploads удаляет
crash stages и артефакты без committed ссылок; referenced originals сохраняются.
Сбой удаления после файловой операции, но до очистки пути безопасен: Remove
идемпотентен. Если ошибка SQLite мешает записать failed, lease восстановит работу.

Коды job errorCode (HTTP job DTO остаётся прежним):

| Код | Значение / действие |
| --- | --- |
| `decode_failed` | Не удалось полностью декодировать original; файл сохранён, автоматического повтора нет |
| `invalid_result` | Playback/тайминг/PCM не прошли проверку; original сохранён |
| `storage_error` | Временный I/O-отказ чтения original/playback, записи, публикации или SQLite; до двух повторов |
| `processing_timeout` | Истёк wall timeout; до двух повторов |
| `processing_interrupted` | Lease восстановлена после прерывания; после трёх попыток failed |

Проверенные импорты: WAV PCM, FLAC, MP3, Ogg Vorbis, MP4/M4A AAC, AIFF PCM,
raw AAC/ADTS, ASF/WMA, WebM Opus. Тесты генерируют синтетический stereo 44.1 kHz
сигнал и проверяют настоящий mono/48 kHz AAC-LC, duration и непустые peaks.
Поддержка определяется decoder/demuxer конкретной сборки, а не расширением.
Проверяются системная **FFmpeg/FFprobe 6.1.1-3ubuntu5** и локальная сборка
**7.1.5** (deployment baseline ADR — 7.1.x), Go **1.27.3**. Важно проверять
конкретную конфигурацию, а не только версию: первоначальная минимальная сборка
7.1.5 имела AAC, но не float PCM muxer, поэтому не могла формировать peaks.
Worker теперь отклоняет такую сборку до listener. В configure этот muxer
называется `pcm_f32le`, хотя CLI использует `-f f32le`. Для production в #14
следует повторить набор проверок с поставляемыми binary. Новых зависимостей нет.

Минимальная конфигурация проверяемой 7.1.5 (Linux, util-linux `prlimit`):

```sh
./configure --disable-everything --disable-doc --disable-debug --disable-x86asm \
  --enable-protocol=file,pipe \
  --enable-demuxer=wav,mp3,flac,ogg,mov,matroska,aac,aiff,asf \
  --enable-decoder=aac,flac,mp3,mp3float,pcm_s16le,pcm_s16be,vorbis,opus,wmav2 \
  --enable-encoder=aac,pcm_f32le --enable-muxer=mp4,pcm_f32le \
  --enable-filter=aresample,asetpts,aformat,anull
make -j2
```

Запуск полного backend набора с этой сборкой, после помещения её ffmpeg/ffprobe
в `/tmp/choral-ffmpeg71-bin`:

```sh
cd backend
PATH=/tmp/choral-ffmpeg71-bin:/tmp/choral-toolchain/go/bin:$PATH \
  CHORAL_TEST_FIXTURE_FFMPEG=/usr/bin/ffmpeg \
  GOCACHE=/tmp/choral-gocache GOPATH=/tmp/choral-gopath \
  go test -count=1 ./...
```

`CHORAL_TEST_FIXTURE_FFMPEG` действует только на генерацию синтетических файлов
в тестах (ей нужны lavfi и дополнительные encoders). Probe, worker, проверка
результата и peaks используют проверяемую сборку из PATH. В приложении этого
параметра нет; при обычном тестировании генерация тоже использует PATH.

Поведенческие проверки #8: настоящая конвертация девяти форматов; лимиты claim
server/song; fencing повторной попытки; corrupt input, настоящий wall timeout,
запрет filesystem write и ошибки результата/SQLite transaction; сохранение старого
active asset и source при каждом отказе; успешный retry, исчерпание попыток;
удаление во время работы; grace cleanup/failed retention. Отдельный процесс
убивается SIGKILL после появления непустого stage при конвертации 1190-секундного
FLAC; startup recovery удаляет leftovers, повтор обрабатывает тот же original и
только после успеха удаляет его. Upload integration использует реальные auth,
SQLite, FS, worker и public GET/HEAD/Range/peaks без готовых asset fixtures.

Дополнительные проверки: сохранение начальной тишины и исходного уровня сигнала,
отказ FFprobe для настоящего PCM вместо playback AAC, зависший result probe
(15 секунд, original остаётся, последующий retry успешен), отказ старта при
отсутствующем float PCM muxer. Job error codes согласованы с OpenAPI.

Проверки исправлений ревью #8: успешная FFmpeg-конвертация с принудительным
сокращением до 100 ms не публикуется и сохраняет original; разница длины
20 ms проходит, 21 ms отклоняется. Padding 20 ms
проходит, 21/22 ms отклоняется до ready/удаления original. Fault injection меняет
только параметры конвертации или probe metadata, PCM/артефакты остаются настоящими.
Временный I/O-отказ декодирования source или playback сохраняет original и старый
active asset и допускает успешный retry. Поведенческий тест внедряет отказ только
на выбранном этапе PCM decode: конвертация и FFprobe остаются настоящими. После
второй попытки новый asset становится active, original удаляется, старый playback
сохраняется на grace-период. Некорректный playback/тайминг остаётся `invalid_result`.
Удаление дорожки во время заблокированной конвертации не допускает второе задание
той же песни, сохраняя доступность второго слота для независимой песни; после
выхода subprocess ожидающее задание успешно обрабатывается.

Исправление retry result FFprobe: отказ запуска/завершения процесса (включая
временный `Input/output error`) получает `storage_error` с общим лимитом трёх
попыток. Успешный probe с невалидным JSON или playback metadata получает
`invalid_result`; превышение 15 секунд — `processing_timeout`. stderr не
публикуется. Поведенческий `TestResultProbeFailureRetries` внедряет отказ только
result probe после настоящей конвертации и проверяет сохранение original/старого
active asset, затем успешную вторую попытку с настоящим FFprobe, переключение
asset и удаление original после commit. Старый playback сохраняется на grace-период.
