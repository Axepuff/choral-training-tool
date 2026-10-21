# Контракт API v1

[`openapi.yaml`](openapi.yaml) — нормативные URL, JSON-схемы, коды и примеры.
ADR: [`../decisions/0001-mvp-contract.md`](../decisions/0001-mvp-contract.md).
Это проектный контракт, не описание уже запущенного сервера.

## Единые правила

- Все JSON — UTF-8; неизвестные поля запроса отклоняются с `422 validation_error`.
  JSON-числа BPM/размера — целые, не строки и не дроби. Обязательные строки
  нормализуются Unicode NFC и обрезаются от окружающих Unicode whitespace;
  после этого считаются Unicode scalar values (`rune` в Go, `Array.from` в JS).
  Пустое название после trim запрещено. Внутренние пробелы сохраняются.
  Невалидные UTF-8/изолированные surrogate запрещены. Проверяются:
  `title` 1–160, `track.name` 1–80, `notes` 0–1000 scalar values, `bpm` 20–300,
  `beatsPerBar` 1–32, `beatUnit` из {1,2,4,8,16,32}, `tracks` 1–32.
  `notes` не обрезаются по краям; NFC выполняется до подсчёта.
  Например, 1000 эмодзи вне BMP допустимы (`Array.from(notes).length=1000`,
  хотя JS `.length=2000`); 1001 — `422`, как и изолированный surrogate.
  `e` + combining accent после NFC считается одним символом.
- Время — UTC RFC3339 (`date-time`); длительности/временные позиции — целые ms.
  Стабильные UUIDv4 — lower-case строки. Песни сортируются по `updatedAt` DESC,
  затем `id` ASC; пользователи — по email ASC, затем `id` ASC. Для страниц
  `limit` 1–100, default 30, cursor opaque, фильтрация на сервере. Правила
  снимка и срока cursor описаны ниже.
  Пустой список возвращает `items: []`, а не 404.
- Ошибки имеют единый объект `error {code,message,details?,requestId}`. `details`
  содержит JSON Pointer поля и машинный код ограничения. Не раскрывать наличие
  чужой приватной песни/ссылки: `404`; `403` — только для известного ресурса,
  где нет права на действие. `401` — нет/истекла сессия; `409 version_conflict`
  — устаревший `If-Match`. Лимит тела — `413`, лимит попыток — `429` с
  `Retry-After`. Идентификатор запроса возвращается также `X-Request-Id`.
- `Idempotency-Key` — UUIDv4, ограничен методом+URL+actor, хранится 24 часа.
  Для JSON сравнивается SHA-256 нормализованного запроса, для multipart — SHA-256
  байтов файла и параметры. При неизменной созданной ссылке повтор с тем же
  телом в этот срок возвращает тот же статус, тело (включая токен/URL
  `POST /shares`) и `Location`/`ETag`; новый `X-Request-Id` допустим.
  Другое тело — `409 idempotency_conflict`.
  Запись результата и создание ресурса фиксируются одной транзакцией до отправки
  ответа. После проверки сессии/CSRF запись повтора проверяется **до** `If-Match`
  и проверки текущего состояния ресурса. `idempotency_records` хранит scope,
  digest запроса, status, заголовки, AES-256-GCM ciphertext ответа, уникальный
  nonce, key ID и `expires_at`.
  Ключ шифрования — внешний постоянный secret; старые ключи сохраняются минимум
  до истечения всех записей. После 24 часов запись удаляется; повтор с прежним
  ключом может создать новый ресурс, поэтому клиент использует новый ключ для
  новой операции. Если ссылка за это время отозвана/перевыпущена, повтор создания
  возвращает `409 idempotency_stale` и не раскрывает старый токен.
- `If-Match: "<version>"` обязателен для изменения песни и загрузки в её дорожку.
  Изменение треков/публикации атомарно повышает версию и возвращает новый ETag.
  Завершение worker также повышает версию. При `409` клиент перечитывает песню;
  server не объединяет старую форму автоматически.

## Данные и транзакции

| Таблица | Ключи и обязательные поля | Инвариант |
| --- | --- | --- |
| `users` | `id`, `email_normalized` UNIQUE, `password_hash`, `role`, `blocked_at`, `must_change_password`, timestamps | email нормализуется trim + lower-case домена/адреса; Argon2id с отдельной солью; роль `teacher`/`admin` |
| `sessions` | `id`, `user_id` FK, `token_hash` UNIQUE, `csrf_hash`, `expires_at`, `revoked_at`, timestamps | хранится hash cookie/CSRF, блокировка/смена пароля отзывает все сессии |
| `songs` | `id`, `owner_id` FK, `title`, `bpm`, `beats_per_bar`, `beat_unit`, `notes`, `publication`, `version`, timestamps, `deleted_at` | `draft`/`published`; `published` требует ≥1 track и каждый active asset ready |
| `tracks` | `id`, `song_id` FK, `position` UNIQUE(song,position), `name`, `gain` default 1, `active_asset_id`, `pending_asset_id` | 1–32, произвольные UUID, порядок 0-based; активный asset не меняется до успеха замены |
| `assets` | `id`, `track_id` FK, `source_path`, `playback_path`, `peaks_path`, `source_bytes`, `source_sha256`, `duration_ms`, `mime`, `sample_rate`, `channels`, `state`, timestamps | внутренние пути из ID; `pending`/`processing`/`ready`/`failed`/`retired`; ready только после проверки артефактов |
| `jobs` | `id`, `asset_id` FK, `state`, `attempts`, `error_code`, `lease_until`, timestamps | `queued`/`processing`/`succeeded`/`failed`/`canceled`; просроченная lease возвращается в очередь |
| `shares` | `id`, `kind`, `owner_id` FK, `song_id` nullable FK, `token_hash` UNIQUE, `disabled_at`, timestamps | `song`: song_id задан и owner совпадает; `list`: song_id NULL, динамический каталог owner; rotate заменяет hash в одной транзакции |
| `idempotency_records` | scope(method, URL, actor, key) UNIQUE, request digest, status, headers, encrypted response, nonce, key ID, expires_at | TTL 24 ч; секретный ответ в БД только зашифрован |
| `page_snapshots` | `id`, scope hash, ordered resource IDs, `expires_at` | TTL 15 минут; состав и порядок страниц заморожены, права проверяются повторно |

SQLite: FK включены на каждом соединении; WAL; транзакции для изменения песни,
ротации ссылки и публикации asset. Выбранные драйвер и способ миграций — в ADR;
точные версии и реализация каркаса относятся к Issue #3.
Файлы временно пишутся под случайным внутренним ID и атомарно переименовываются
на томе. Для успешного job: проверить playback и peaks, fsync/rename артефакты,
затем транзакцией переключить `active_asset_id`, пометить job succeeded и
зафиксировать song version. Только после commit удалить оригинал. При сбое
старый asset и оригинал остаются; уборщик повторяет удаление после commit.
Если трек удалён или superseded до завершения, job отменяется, результат не
подключается. Отставшие assets удаляются после отсутствия ссылок и grace 24 ч.
Исходник с ошибкой хранится до явного удаления песни или успешной новой загрузки
в ту же дорожку; уборщик не удаляет единственную копию после тайм-аута.

## Identity и authorizer для независимых Go-пакетов

```go
type Identity struct { UserID string; Role string; SessionID string }
type Resource struct { SongID string; OwnerID string; Publication string; Ready bool }
type ShareGrant struct { Kind string; OwnerID string; SongID string; ShareID string }
type Authorizer interface {
    CanReadSong(ctx context.Context, identity *Identity, share *ShareGrant, song Resource) bool
    CanEditSong(ctx context.Context, identity Identity, song Resource) bool
    CanManageShare(ctx context.Context, identity Identity, song *Resource, ownerID string) bool
    CanManageUsers(ctx context.Context, identity Identity) bool
}
```

`Identity` получается только из серверной сессии. `ShareGrant` получается только
после hash-проверки активного токена и каждый запрос проверяется заново. Пакеты
songs/sharing/media не читают role или owner из клиентского JSON. `CanReadSong`
для share дополнительно проверяет `published && Ready` и совпадение song/owner.
Код выше — типовой интерфейс контракта, не фиктивная реализация backend.

## Таблица прав

| Действие | anonymous без токена | anonymous с song/list токеном | teacher-owner | teacher-other | admin |
| --- | --- | --- | --- | --- | --- |
| `GET /auth/me` | 401 | 401 | свой профиль | свой профиль | свой профиль |
| Список `/songs` | 401 | 401 | свои (включая draft) + чужие published/ready | свои + чужие published/ready | все |
| Читать конкретную песню/peaks/media | 401/404 | только разрешённые published/ready | свою; чужую published/ready | чужую published/ready | любую, media только ready |
| Создать песню | 401 | 401 | да, owner=self | да, owner=self | да, owner=self |
| Менять/удалять песню, треки, загружать | 401 | 401 | свою | нет | любую |
| Создать/отозвать/перевыпустить share | 401 | 401 | для своего owner/song | нет | для любого owner/song |
| Управлять пользователями | 401 | 401 | нет | нет | да |

Под `teacher-other` понимается преподаватель, запрашивающий песню другого
владельца; у него всё равно есть право управлять **своими** песнями. Наличие
действительной сессии не расширяет область публичного URL; публичные endpoints
проверяют токен независимо. UI может скрывать действия, но решение всегда серверное.

## Публикация и публичные URL

- `POST /shares` создаёт ссылку `song` или `list` (для list задаётся ownerId).
  Одному owner можно создать несколько независимых ссылок. В JSON токен и URL
  возвращаются при создании/перевыпуске и идемпотентном повторе создания в
  течение 24 часов; затем доступен лишь статус. В `shares` остаётся только hash
  токена, временная зашифрованная копия ответа находится в `idempotency_records`.
- `GET /public/shares/{token}` для song возвращает один объект в `songs` и
  `nextCursor=null`, для list — страницу текущих published/ready песен owner.
  Песня уходит из списка при снятии публикации, удалении или потере ready.
  Новые опубликованные песни появляются в **новом** обходе. Токен list не
  открывает чужой owner. Клиент загружает все страницы одного снимка перед
  локальным поиском/сортировкой.
- Первый запрос списка без `cursor` запоминает отсортированные ID песен,
  удовлетворявших фильтру в момент чтения SQLite, на 15 минут. Каждая следующая
  страница берёт ID из этого неизменяемого порядка; обновление `updatedAt` не
  перемещает песню через cursor. Поля песни читаются актуальные. Перед выдачей
  каждой песни сервер заново проверяет session/share, owner, `published` и ready;
  снятые с публикации/удалённые записи пропускаются. Новые публикации после первого
  запроса не входят в снимок. Каждая всё ещё доступная песня из снимка будет
  выдана ровно один раз при полном обходе за 15 минут. Тот же подход действует
  для `/songs` и `/admin/users`, с проверкой текущих прав на каждой странице.
- Cursor привязан к снимку, маршруту и actor (для публичного списка — к токену
  ссылки), содержит подписанную позицию и не раскрывает ID. Другая область или
  неверная подпись → `400 invalid_cursor`; истечение 15 минут → `410
  cursor_expired`, клиент начинает новый обход без cursor. Отзыв ссылки между
  страницами → `404`, даже если снимок ещё существует. Просроченные снимки
  удаляются. Для song-ссылки `nextCursor=null`.
- Публичные media/peaks URL содержат токен и проверяют его на **каждом** запросе,
  включая Range. `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`,
  `Vary: Cookie` для приватных путей; HTML frontend также отдаётся с
  `Referrer-Policy: no-referrer`. Не размещать токен во внешних аналитических
  системах. Отзыв вступает в силу для следующего запроса; уже полученные байты
  недоступно отозвать. Оригинальные файлы никогда не выдаются.

## Аудио, пики и совместимая замена

- Multipart `file`: 100 MiB max, `Content-Length` или ограниченный streaming;
  принимать файл с любым именем, но доверять только FFprobe и декодеру. После
  проверки duration 1 ms–1 200 000 ms, mono/stereo/multichannel import
  сводится в mono с защитой от clipping. Не обещать, что каждый codec поддержан.
  В ответе `202` — durable job, а не готовый файл.
- Активный playback: `audio/mp4`, AAC-LC mono 48 kHz 96 kbit/s. Проверить
  возможность полного decode, число каналов, sample rate и фактическую длину.
  Не менять tempo или обрезать паузы. Допустимая погрешность длины после decode
  ≤20 ms; иначе job failed. `durationMs` отражает декодированную длительность.
- Peaks — массив пар min/max амплитуд в `[-1,1]`, шаг 100 ms, из декодированного
  playback, `startMs=0`, `stepMs=100`, `durationMs` и `points.length =
  ceil(durationMs/100)`. Последнее окно может быть короче. Клиент рисует их по
  общему времени, не выводит длительность из BPM. Длина песни — max активных
  `durationMs`, bar duration = `60000 * beatsPerBar * 4 / (bpm * beatUnit)`;
  `barCount = ceil(songDurationMs / barDurationMs)`. Тишина за концом короткой
  дорожки создаётся плеером, файл не дополняется. Если у draft нет готовых
  дорожек, durationMs=null, barCount=null.
- Диапазон media: `Range: bytes=a-b` → `206`, `Content-Range`, `Accept-Ranges:
  bytes`, `Content-Length`, `ETag`; без Range → `200`; недопустимый/вне файла
  → `416` с `Content-Range: bytes */total`. `HEAD` зеркалит заголовки GET.
  При отсутствии ready — `409 media_not_ready` для редактора; публично `404`.
- Новая загрузка в track создаёт `pending_asset_id`. Пока job идёт, старый
  `active_asset_id`, media URL, peaks и ready остаются прежними. После успеха
  переключение атомарно, те же URL отдают новый ETag. При ошибке старый asset
  остаётся. Удаление track или отмена draft отклоняет/отменяет ожидающее задание.
  Удаление трека в published песне допускается лишь если итоговые tracks готовы;
  замена файла не требует снятия публикации.

## Сессии, CSRF и аккаунты

- `POST /auth/login` ставит cookie и возвращает профиль + `csrfToken`; сообщение
  при неверном email/пароле одинаково. Пять неуспешных попыток за 15 минут
  на комбинацию IP/email → `429` на 15 минут (реализация хранит лимит устойчиво).
  При успешном входе сессию ротировать; при `mustChangePassword` разрешить
  только `/auth/me`, `/auth/password`, `/auth/logout`.
- `GET /auth/me` отдаёт `csrfToken` текущей сессии. Для POST/PUT/PATCH/DELETE
  с cookie нужны exact same-origin `Origin` и этот токен в заголовке. При
  отсутствующем/чужом Origin или токене — `403 csrf_failed`. Login требует Origin
  и `Content-Type: application/json`, но не старый CSRF-токен. CORS не включён.
- `POST /auth/logout` отзывает текущую сессию и очищает cookie. Блокировка,
  смена/сброс пароля отзывает все сессии пользователя. Bootstrap admin выполняется
  только локальной командой при пустой БД, без HTTP endpoint. Администратор
  создаёт пользователей и задаёт временные пароли через `/admin/users`; передача
  пароля адресату — вне системы. Если единственный admin потерял доступ, локальная
  операторская команда `reset-admin` с паролем через защищённый stdin сбрасывает
  именно его пароль, отзывает сессии и требует смены при следующем входе; HTTP
  endpoint для этого нет. Пароль min 12/max 128 Unicode scalar values, без trim;
  Argon2id: 64 MiB памяти, 3 прохода, parallelism 1, salt 16 B, hash 32 B.
  Запрещено блокировать/понижать последнего активного администратора (`409`).

## Расхождения с текущими моками

- `?song=quiet-evening` и `?list=choir-demo` предсказуемы и не являются токенами.
  В v1 ссылки используют случайный token и серверную проверку на каждом запросе.
- Роль/owner сейчас props/строки; в v1 их выдаёт сессия и проверяет сервер.
  Обычная форма входа не отправляет запрос. Сохранение песен сейчас только в памяти.
- `maxLength` и `.length` в React считают UTF-16 code units; v1 считает после NFC
  Unicode scalar values. Frontend должен согласовать счётчик и сообщения ошибок.
- ID мок-треков ограничены голосами; v1 поддерживает 1–32 произвольных UUID.
  BPM/размер/волны/длительность плеера сейчас демонстрационные; текущий расчёт
  тактов не учитывает `beatUnit`, тогда как v1 считает BPM по четвертям.
  Реальное аудио отсутствует. Форма показывает имена старых файлов как заглушки
  и не загружает их.
- Повтор тактов 2–3 пока фиксирован в UI; v1 API не делает его пределом.

## Проверка контракта

Спецификация должна проходить OpenAPI 3.1 validator. Временные инструменты для
проверки не становятся runtime-зависимостями проекта. Примеры в YAML проверяются
как JSON-схемы, а последовательности запросов и ожидаемые права — по таблице выше.

## Реализация auth в Issue #4

Auth endpoints и `PUT /admin/users/{userId}/password` реализованы на Go/SQLite;
остальные разделы остаются контрактом соответствующих задач. Настройки origin,
операторские bootstrap/create-teacher/reset-admin, local HTTP и поведенческие
проверки описаны в [backend.md](../backend.md#авторизация-issue-4).
Обязательная смена временного пароля на остальных API даёт
`403 password_change_required`; отсутствующая/недействительная сессия — 401,
ошибка CSRF — `403 csrf_failed`. Эти ошибки различаются также в Go identity provider.
Самостоятельная смена пароля, согласно OpenAPI, возвращает 204, отзывает все
сессии и требует нового login с новым случайным cookie ID.
