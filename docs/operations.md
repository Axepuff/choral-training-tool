# Контейнерный запуск и восстановление — Issue #14

Это подготовка к размещению, **не production rollout** (#16). Приложение и API
обслуживает один Go-процесс на одном origin. Дизайн и компоненты не меняются.
Исторические разделы handoff/architecture про отсутствие backend уже заменены
кодом #3–12; для текущего запуска используйте этот документ и backend.md.

## Сборка и запуск

Нужны Docker Engine с Buildx/BuildKit и Compose v2, Linux containers, интернет для сборки и место
для image/build cache, данных и резервной копии. Хостинг и платные сервисы не нужны.
Из корня checkout:

```sh
cp .env.example .env
# Указать CHORAL_ORIGIN=https://имя-хоста (без завершающего /).
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8080/livez
curl --fail http://127.0.0.1:8080/readyz
```

Без HTTPS можно проверить health/assets через loopback; полноценный login требует
HTTPS и Secure cookie. CHORAL_LOCAL_HTTP намеренно false: контейнер слушает
0.0.0.0, а небезопасный dev-режим допускает только loopback listener. Не обходить
эту проверку. Для локальной полной проверки настройте доверенный локальный TLS proxy.
CHORAL_HTTP_PORT меняет только порт loopback хоста (по умолчанию 8080).

Node 24.19.0, Go 1.27.3 и Debian bookworm закреплены manifest SHA-256 в Dockerfile.
Пакеты runtime (FFmpeg/FFprobe, prlimit, SQLite CLI, CA) берутся из подписанного
Debian snapshot 20261027T000000Z. Проверка срока Valid-Until отключена только для
исторического snapshot; TLS, подпись Release и checksum пакетов остаются включены.
Не использовать trusted=yes, --allow-unauthenticated, curl -k, GOSUMDB=off.
Go использует go.sum и go mod verify, npm — lockfile/npm ci. GOTOOLCHAIN=local
запрещает скрытую замену компилятора. Для сравнения результатов используйте одну
архитектуру и те же digest; обновляйте digest/snapshot отдельным проверенным изменением.

Frontend собирается с VITE_APP_DEMO=false и base=/; Go раздаёт только /app из
image. Query URLs и вложенные HTML routes получают index; /assets/missing.js и
неизвестный /api возвращают 404. Каталоги не листятся, dotfiles закрыты.
CHORAL_STATIC_DIR для запуска без Docker указывает на production dist; при
отсутствующем index сервер отказывает до listen. Не указывайте data как static dir.

Процесс UID/GID 10001:10001, root filesystem read-only, capabilities сброшены,
no-new-privileges, лимиты 2 CPU/3 GiB/128 PID. /tmp — ограниченный tmpfs 128 MiB.
Volume data монтируется в /data; Docker создаёт его с владельцем каталога image.
Для bind mount владелец должен заранее предоставить UID 10001 доступ 0700;
сервис не делает chown от root. Масштабирование реплик не поддерживается.

Healthcheck вызывает собственный subcommand choral-server healthcheck и проверяет
/readyz. /livez — живой HTTP процесс; /readyz — доступность SQLite и отсутствие
остановки. FFmpeg/FFprobe capabilities проверяются worker до listen; это не
проверка свободного места или внешнего proxy. SIGTERM закрывает listener, даёт
HTTP до 15s на завершение, отменяет worker/subprocess и закрывает SQLite/storage.
Compose оставляет 30s до SIGKILL. Durable jobs восстановятся после restart.

Аккаунты создаются существующим choral-accounts (см. [backend.md](backend.md)),
через docker compose exec -T app choral-accounts …; пароль вводится в stdin,
не в аргументах, env, репозитории или журнале. Не запускайте bootstrap для smoke
с реальными credentials. Сервисы регистрации/почты не требуются.

## Постоянные данные и резервное копирование

Один named volume содержит choral.sqlite, WAL/SHM, replay/sharing ключи, files с
original/playback/peaks и промежуточными файлами. Restart/recreate/build/down
без -v сохраняют его. **docker compose down -v удаляет данные**; применять только
к изолированному тестовому проекту. Не копировать один sqlite при работающем
сервисе: worker может опубликовать/удалить файл между снимками. Одна SQLite .backup
также не обеспечивает согласованность с файлами и ключами.

Поддерживаемая процедура — короткий maintenance stop. Закрыть входящий traffic,
остановить все writers (включая CLI/другие Compose projects, использующие этот
volume), дождаться завершения. Не выполнять startup/обновление одновременно с
backup. Скрипт проверяет отсутствие running app текущего проекта; блокировка
других операторов/проектов — обязанность владельца, это не distributed lock.

```sh
docker compose stop app
# Проверить graceful exit 0; при 137 сначала выяснить причину принудительной остановки.
docker inspect -f '{{.State.ExitCode}}' "$(docker compose ps -aq app)"
sh scripts/backup-restore.sh backup /absolute/private/backups/release-before-update
docker compose up -d
```

Родитель backup directory должен существовать; конечный каталог должен быть новым.
Скрипт создаёт его с umask 077, проверяет SQLite integrity_check/foreign_key_check,
потоком архивирует **весь остановленный volume**, включая WAL и ключи, и сохраняет
SHA256SUMS. Архив не хранится во временном FS контейнера и не требует совпадения
UID хоста/контейнера. Ошибка оставляет .partial, который нельзя восстанавливать.
Backup не выводит содержимое/ключи. В архиве есть чувствительные данные: хранить
его вне Git/public assets, ограничить доступ и шифровать средствами владельца
при выносе с машины. SHA-256 обнаруживает повреждение, а не подмену: принимать
только собственные доверенные архивы; скрипт не предназначен для чужих tar-файлов.

## Восстановление в чистый volume

1. Проверить checksum и доступность **того же image** и compose/env. Сохранить
   image tag/digest, версию приложения и список миграций рядом с закрытым backup.
2. Выделить новый Compose project/пустой volume. Не очищать рабочий volume и не
   восстанавливать поверх существующих файлов: команда откажет.
3. Восстановить, затем запустить с исходной версией image:

```sh
export COMPOSE_PROJECT_NAME=choral-restore-check
export CHORAL_HTTP_PORT=8081
# Образ choral:local должен соответствовать версии backup; не пересобирать его здесь.
sh scripts/backup-restore.sh restore /absolute/private/backups/release-before-update
docker compose up -d --no-build
curl --fail http://127.0.0.1:8081/readyz
```

4. Restore до извлечения проверяет SHA256SUMS на хосте; внутри требует пустой /data,
   извлекает от UID 10001 и проверяет integrity_check и foreign_key_check. При ошибке
   не запускать сервис; оставить этот отдельный volume для разбора или создать
   ещё один чистый. Нельзя повторять restore поверх частично извлечённых данных.
5. Прочитать заранее выбранную контрольную песню через обычный UI/API, её metadata,
   media (включая Range) и peaks; сравнить размер/хеш контрольного файла с записью
   до backup. Проверить опубликованную ссылку: ключи тоже должны восстановиться.
   Не печатать приватные токены/ключи в отчёт. Это обязательный операторский smoke
   для **каждой реальной** копии, а не следствие успешного integrity_check.
6. Проверить очередь/свободное место и только после этого переключать proxy.
   Старый volume оставить до подтверждения. В изолированном тесте удалить только
   project choral-restore-check, убедившись в правильном COMPOSE_PROJECT_NAME.

## HTTPS proxy и ограничения

TLS терминирует отдельный reverse proxy на хосте, backend порт доступен только
через 127.0.0.1. Сертификат, DNS и firewall — этап #16. Пример nginx server после
настройки certificate/key владельцем (их пути/значения в Git не помещать):

```nginx
server {
    listen 443 ssl;
    server_name choir.example.test;
    # ssl_certificate / ssl_certificate_key задаются владельцем.
    client_max_body_size 101m;
    client_body_timeout 30s;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_connect_timeout 5s;
        proxy_send_timeout 35s;
        proxy_read_timeout 35s;
    }
}
```

Публичный origin должен **точно** совпадать с CHORAL_ORIGIN. Не добавлять CORS или
переписывание /api. Не логировать query публичных ссылок, cookies/Authorization
или тела; access log proxy отключить либо настроить без query/секретных полей.
HTTP на 80 перенаправлять на HTTPS. При внешнем proxy в контейнере нужен отдельный
закрытый network; не публиковать Go на 0.0.0.0 хоста.

Сервер: 101 MiB body с multipart overhead, один файл максимум 100 MiB;
headers 16 KiB/5s, HTTP read/write 30s, idle 60s. Медленный upload может завершиться
раньше лимита proxy — это осознанный текущий серверный бюджет; увеличивать только
согласованно с admission/timeouts backend. Обработка асинхронна, proxy не ждёт
FFmpeg. Для media сохранять Range/HEAD и не кешировать приватные ответы в proxy.

## Обновление, rollback и диск

До обновления проверить свободное место **и inode** на Docker storage/volume и
backup destination: нужны одновременно старые данные, новые uploads/артефакты,
backup, старый и новый images/build cache. Учитывать 100 MiB original, временный
playback/peaks и две обработки; не рассчитывать только на размер текущей БД.
Настроить мониторинг диска, failed jobs и backup age у владельца. Уборщик приложения
не является политикой retention backup и не освобождает Docker build cache.

Собрать новый immutable release tag заранее (CHORAL_IMAGE_TAG), сохранить старый
image (docker image save при необходимости), закрыть traffic, stop и backup.
Запустить новый image с тем же volume; readiness и контрольный song/media smoke
выполнить до открытия traffic. Миграции автоматические forward-only, checksum
проверяется; изменённая/неизвестная миграция останавливает startup. Down migrations нет.

Rollback к старому image допустим только при явно проверенной совместимости схемы.
Обычно требуется **старый image + полный backup до миграции в новый volume** и
переключение proxy; одного image rollback недостаточно. Данные, принятые после
backup, потеряются при таком rollback: заранее ограничить окно записи и согласовать
решение с владельцем. Не удалять старый volume/image до приёмки восстановления.

## Проверки и границы результата

```sh
# Изолированный Docker project, синтетические данные, сам удаляет свои volumes:
sh scripts/check-container.sh
# Реальная SQLite/FS, нужен sqlite3 CLI в PATH:
cd backend
go test ./...
go vet ./...
```

check-container проверяет build/run/health, deep URL/query/assets/API misses,
UID/read-only, сохранение контрольной записи/файла после restart и rebuild,
SIGTERM exit 0, backup и восстановление после удаления тестового volume.
Go TestBackupCleanRestore вызывает тот же entrypoint с настоящей SQLite/FS,
читает контрольную запись, файл и синтетический ключ из чистого каталога,
проверяет отказ overwrite/corruption. TestProcessHealthAndSIGTERM запускает
настоящий Go/FFmpeg сервис, HTTP frontend/readiness и SIGTERM; platform suite
также проверяет drain активного HTTP. Никакой mock success в runtime не добавлен.

Первичный агент не имел доступа к Docker из sandbox. После установки Docker
владельцем контейнерная проверка выполнена на WSL-хосте (результаты ниже).
Локальные проверки не означают запуска production или завершения #16.

Pages/Storybook остаются отдельным статическим preview: workflow использует
VITE_APP_DEMO=true и относительный base, assemble-pages публикует приложение в
/app/. Backend/data/keys не включаются. Docker собирает только runtime dist и Go;
Storybook/demo preview не является production и не предоставляет сохранение данных.

### Выполнено в sandbox 28 октября 2026

- Go 1.27.3 установлен в /tmp с проверкой SHA-256 из backend.md;
  go test -count=1 ./... и go vet ./... прошли, включая настоящий FFmpeg хоста.
- TestBackupCleanRestore выполнен **без skip**, с настоящим SQLite CLI 3.45.1:
  backup → чистый каталог → чтение контрольной записи/файла/синтетического ключа;
  отрицательные проверки overwrite, повреждённых tar и SQLite прошли.
- TestProcessHealthAndSIGTERM и TestFrontendRoutes прошли; существующий
  TestGracefulShutdownDrainsRequest также прошёл.
- npm ci, typecheck, lint, production build (base=/, demo=false), отдельный demo
  build, build-storybook и assemble-pages прошли. Storybook предупредил о размере
  chunks; play/browser проверки здесь не запускались, UI-компоненты не менялись.
- sh -n для трёх новых shell scripts и git diff --check прошли.
- check-container.sh **не запускался**: Docker CLI отсутствует и подключение к
  /var/run/docker.sock недоступно. Container FFmpeg, image build и Docker volume
  persistence не следует считать проверенными по результатам host-тестов.

### Проверка на Docker-хосте 28 октября 2026

Docker Engine 29.1.3, Compose 2.40.3, Buildx 0.30.1, Linux/amd64 в WSL.
Buildx из Ubuntu-пакета подключён во временном Docker config; членство в группе
docker применено через `sg docker`, без изменения прав daemon socket.

`sh scripts/check-container.sh` прошёл: сборка, health/readiness, deep URL/query
и assets, ответы 404 для отсутствующих assets/API, UID 10001 и read-only root,
сохранение записи SQLite и файла после restart/rebuild, SIGTERM exit 0,
backup → новый чистый volume → чтение исходной записи и файла. Тестовый project
и его volumes удалены самим сценарием; пользовательские данные не затрагивались.

До исправления `.dockerignore` BuildKit воспроизвёл `stat /src/cmd/server:
directory not found`: правило `**/server` исключало исходники команды вместе
с бинарником. Правило сужено до `/backend/server`; полный сценарий прошёл
после исправления. Сборка сохраняет TLS, проверку digest образов и подписей APT.

В собранном образе `choral:check-40002` с FFmpeg 5.1.9-0+deb12u1 прошёл полный
`internal/processing` suite без skip: test binary собран через
`CGO_ENABLED=0 go test -c -o /tmp/choral-issue14-processing.test ./internal/processing`
из backend и смонтирован read-only в image; запуск — с UID image и read-only root.
Первый прогон с обычным noexec `/tmp` не смог выполнить тестовые подмены
ffmpeg/ffprobe и провалил fault injection. Повтор с
`--tmpfs /tmp:exec,size=512m,mode=1777` прошёл все проверки реальных форматов,
артефактов, восстановления worker, отмены и ошибок. Exec включён только для
этого теста, Compose приложения не менялся. Это проверка packaged FFmpeg,
а не новый браузерный или физический мобильный прогон.
