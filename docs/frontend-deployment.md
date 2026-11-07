# Независимый frontend release — Issue #65

Один origin и Go-сервис сохраняются. Базовый Dockerfile по-прежнему содержит
резервную production-сборку `/app`. Опциональный `compose.frontend.yaml` переводит
раздачу на `CHORAL_STATIC_DIR=/frontend/current`. Backend image, SQLite и FFmpeg
отдельно от frontend обновляются по [operations.md](operations.md).
Ни одна команда ниже не является разрешением менять production.

## Контракт артефакта и допуска

На машине сборки нужны Python 3.11+, Node из Dockerfile и `npm ci` по lockfile.
На хосте публикации — Linux, Python 3.11+, локальная файловая система с atomic
rename/flock; Node, Go и Docker для регулярного deploy не нужны.

```sh
# Чистый checkout конкретного проверенного commit. Артефакт хранить вне checkout.
npm ci --no-audit --no-fund
python3 scripts/frontend-release.py build --output /tmp/frontend.tar
```

Команда выполняет typecheck/Vite build с принудительными `VITE_APP_DEMO=false`,
`CHORAL_BUILD_BASE=/`, сохраняет Vite manifest для проверки транзитивных chunks,
затем формирует детерминированный несжатый tar (не более 128 MiB):

- `release.json`: `format=1`, полный 40-символьный `commit`, `api=choral-api-v1`,
  `demo=false`, `base=/`, `files` — отображение пути в SHA-256 содержимого;
- `index.html`, плоский `assets/` с хешированными именами Vite и существующие
  `fonts/jost/OFL.txt`, `fonts/jost/SOURCE.txt` с лицензией/источником шрифта;
- рядом `frontend.tar.sha256` — SHA-256 **всего архива**.

В tar запрещены ссылки, устройства, директории, dotfiles, произвольные пути,
дубликаты и файлы вне inventory. Index должен ссылаться на существующие
`/assets/…`; архив проверяется целиком до изменения `current`. Предел 10 000 файлов.
Commit одновременно является immutable release ID: другая сборка того же commit
не заменяет опубликованные байты. Checksum защищает от повреждения, а не от
подмены: источник архива и запись о допуске должны быть доверенными.

`choral-api-v1` — метка совместимости с **установленным** API из
`docs/api/openapi.yaml`, включая принятый контракт `sourceName`. Она не доказывает,
что новый frontend не требует нового endpoint/поля. До публикации reviewer должен
подтвердить совместимость с backend image, реально установленным на хосте,
и успешные проверки поведения для этого commit. В журнале выпуска сохранить
backend image ID/commit, frontend commit, SHA-256 архива, API label и ссылку
на проверки/одобрение. `--approved-commit` и `--backend-api` — явное утверждение
оператора по этому журналу; скрипт сверяет его с manifest, но не запрашивает GitHub
и не определяет установленный API автоматически.

Frontend, требующий нового API, **не допускается** независимо: сначала согласованное
совместимое обновление backend, затем frontend; несовместимое изменение требует
общего maintenance/backup плана. Старые вкладки тоже используют API, поэтому backend
должен оставаться совместимым с сохранёнными frontend-релизами.
В #66 автоматизация должна привязать уже проверенный артефакт и разрешение к этому
точному commit/checksum/API. Этот PR не меняет workflows и не включает автодоставку.

## Однократный переход Compose

Выполнять в согласованное окно под существующим maintenance lock, отдельно от
регулярного deploy. До изменения сохранить compose/env и точный backend image ID.
Должен быть установлен backend с новым static cache/ETag handler из #65; его первое
обновление выполняется по обычному backend runbook с backup и проверкой миграций.
Для перехода mount уже на этом image миграций не добавлено.

1. Выбрать отдельный каталог, например `/srv/choral-frontend`, **вне** `/data`,
   Docker private volume, backup roots и checkout. Владелец — оператор; запись
   посторонним запрещена; каталог и родители доступны на чтение/проход UID 10001.
   Не использовать сетевую FS. Зарезервировать место на все сохраняемые релизы.
2. Загрузить готовый архив и checksum во временный каталог **вне** release root.
   Выполнить команду publish из следующего раздела: она создаст `current` до старта.
3. Установить `compose.frontend.yaml` рядом с основным Compose. В `.env` записать:

   ```dotenv
   COMPOSE_FILE=compose.yaml:compose.frontend.yaml
   CHORAL_FRONTEND_ROOT=/srv/choral-frontend
   ```

   Сохранить прежние origin/image/project/port. Проверить `docker compose config`
   приватно: `/data` остаётся прежним, **стабильный родитель** `/srv/choral-frontend`
   смонтирован в `/frontend:ro`, static dir — `/frontend/current`. Монтирование
   самого symlink или каталога текущего релиза закрепило бы старый inode.
4. Обновить установленный комплект backup helpers: вместе с существующими scripts
   поставить `frontend-release.py`, изменённые `backup-restore.sh`, `copy-backup.sh`,
   `backup-health.py`, `prune-backups.py`, `verify-backup-restore.py` в тот же
   `/usr/local/lib/choral-backup`. Их зависимости и scheduled timer сохраняются.
5. Один раз пересоздать **только app**, без build и без удаления volume:

   ```sh
   docker compose up -d --no-build --force-recreate --wait --wait-timeout 90 app
   curl --fail http://127.0.0.1:8080/readyz
   ```

   Проверить HTTPS index/deep link/assets/API, login и контрольную песню.
   После этого обычный frontend deploy не вызывает Compose.

Откат **перехода**: вернуть прежний `COMPOSE_FILE`/env и compose config, убрать
только frontend override, затем `up -d --no-build --force-recreate … app` с прежним
совместимым image. Go снова раздаёт встроенный `/app`. Это пересоздание контейнера,
не регулярный frontend rollback. При уже выполненном обновлении backend применяются
его ограничения схемы/rollback из operations.md. Не удалять внешний frontend root.

## Регулярная публикация и откат

Одна команда публикации готового архива (значения из журнала допуска):

```sh
python3 scripts/frontend-release.py publish /absolute/uploads/frontend.tar \
  --root /srv/choral-frontend --sha256 <64-hex-sha256> \
  --approved-commit <40-hex-frontend-commit> --backend-api choral-api-v1
```

Одна команда отката на сохранённый release ID:

```sh
python3 scripts/frontend-release.py rollback --root /srv/choral-frontend \
  --to <40-hex-previous-commit> --backend-api choral-api-v1
```

Обе команды используют один неблокирующий flock: конкурирующий deploy, rollback,
prune или snapshot получает ненулевой статус и не переключает релиз. Перед
switch проверяются inventory/checksums, index, API label, разрешённый commit,
коллизии неизменяемых assets. Новый релиз сначала полностью готовится на том же
томе; symlink `current` заменяется atomic rename с fsync. Ошибка загрузки/валидации
оставляет старый `current`; при сбое диска до switch могут остаться неиспользуемые
assets/staging, которые не становятся активным релизом. После ошибки fsync после
rename проверить `readlink current`: переключение могло уже состояться.

Команды работают только с release root и входным архивом. Они не вызывают Docker,
SQL, migrations, backup/restore и не обращаются к private volume. Backend PID и
container ID сохраняются. Плановый backup продолжает свою отдельную штатную
остановку по timer; deploy не отменяет и не запускает её.

Короткий smoke после публикации: index и deep link показывают новый frontend;
новые и прежние assets отвечают 200, `/assets/missing.js` и `/api/missing` — 404,
`/readyz` и штатное чтение API работают. В открытой до switch вкладке проверить
действие, подгружающее asset, и API. При проблеме выполнить rollback и повторить
smoke. Не повторять все suites при доставке уже проверенного архива.

## Кеш и хранение

Go разрешает symlink `current` один раз на HTTP-запрос: HTML запроса не меняется
посередине switch. Index, прямой `/index.html` и SPA deep links получают `no-cache`
и ETag от содержимого: браузер перепроверяет HTML, даже если две сборки созданы
в одну секунду. Хешированные assets получают
`public, max-age=31536000, immutable`, включая HEAD/Range/304; отсутствующие
assets не получают immutable cache. API сохраняет `no-store`.

Каждый release использует общий append-only `assets/`; одинаковый URL никогда
не заменяется другими байтами. Поэтому вкладки прежнего релиза могут получить
его JS/CSS/fonts после switch и rollback. Current хранится постоянно, остальные
релизы — **минимум 7 суток после последней деактивации**. Более старые вкладки
после очистки должны обновить страницу; бессрочная поддержка не обещается.
Срок меняется отдельным изменением контракта, не флагом сокращения retention.

```sh
# По умолчанию только список. Выполнять явно, при наличии проверенных архивов.
python3 scripts/frontend-release.py prune --root /srv/choral-frontend
python3 scripts/frontend-release.py prune --root /srv/choral-frontend --apply
```

Prune держит тот же lock, проверяет все релизы, удаляет только неактивные старше
7 суток и старые assets, не используемые ни одним сохранённым релизом. Возраст
сборки не заменяет время последнего использования. Current не удаляется. Backup
артефакты хранятся отдельно и этой командой не затрагиваются. Не чистить каталоги
через `rm`/mtime независимо от manifest. Незавершённые `.stage-*` после аварии
осматривает оператор под lock; они не выдаются Go и не очищаются автоматически.

## Backup и точное восстановление

Штатный backup после остановки writers по-прежнему сохраняет весь private volume.
Если у остановленного app есть mount `/frontend`, `backup-restore.sh` дополнительно
вызывает `snapshot` под frontend lock и сохраняет `frontend.tar` и `FRONTEND.json`
(commit/API/checksum) **вне** private volume. Все три файла (`data.tar`,
`frontend.tar`, `FRONTEND.json`) входят в `SHA256SUMS`. IMAGE_ID фиксирует backend,
COMMIT — checkout backend, а frontend commit берётся из FRONTEND.json.
Ошибка snapshot не создаёт завершённый SHA256SUMS; scheduled backup возвращает app
через существующий recovery trap. Вторая копия, health и retention учитывают новые
файлы; старые backup со встроенным frontend поддерживаются.

Для восстановления внешнего frontend на новом хосте/изолированном проекте:

1. Проверить `sha256sum -c SHA256SUMS`, сохранить тот же backend image ID,
   compose/env и оба commit. Создать новый frontend root, не production root.
2. Взять значения из проверенного `FRONTEND.json`, выполнить обычный `publish`
   для **backup/frontend.tar**, указав их как checksum/approved-commit/backend-api.
3. Указать новый `CHORAL_FRONTEND_ROOT` и frontend Compose override. Выполнить
   обычный `backup-restore.sh restore` в **новый пустой private volume**, затем
   `up -d --no-build` с исходным backend image. Restore private data сам по себе
   не переключает frontend и не заменяет работающий frontend root.
4. Проверить не только SQLite/media/share, но и index/commit, assets/deep link.
   Не пересобирать frontend из текущего main вместо сохранённого артефакта.

`verify-backup-restore.py` автоматически разворачивает сохранённый frontend во
временном каталоге и монтирует его read-only в изолированный restore container.
Этот snapshot переносит текущий релиз; для восстановления также прежних открытых
вкладок дополнительно сохранять доверенные артефакты всех релизов retention-окна
и публиковать их перед активацией текущего. В обычном deploy они остаются на месте.

## Целевые проверки

```sh
python3 scripts/check-frontend-release.py
# Настоящий Go/SQLite/FFmpeg процесс на временных data и свободном loopback порту:
python3 scripts/check-frontend-release.py --server /absolute/test/choral-server
# Compose + одна открытая вкладка Chrome, отдельный disposable project/volume:
CHROME_BIN=/absolute/chrome python3 scripts/check-frontend-container.py \
  --image <existing-runtime-image> --server /absolute/test/choral-server
# Только изменённая ветка restore acceptance, с вымышленными song/list fixtures:
python3 scripts/check-restore-acceptance.py sha256:<existing-runtime-image-id> --frontend
cd backend
go test ./internal/platform -run TestFrontend -count=1
```

Полный backend/restore/browser suite не является условием каждого frontend deploy.
Изменения backup helpers проверяются отдельно их профильными сценариями. Приёмка
Compose и открытой вкладки описана в [QA #65](qa/2026-11-02-frontend-deploy.md).

## Артефакт из CI — Issue #66

Для обычной доставки используйте архив уже прошедшего проверки push main.
[Карта CI и правила допуска](ci.md) объясняют происхождение артефакта, обязательный
check и проверку совместимости. PR #68 отдельно документирует первый production
переход и ручную сборку; его инструкция сборки остаётся процедурой подготовки
нового кандидата, а не заменой допуска CI в этом пути доставки.

На Linux-машине оператора нужны Python 3, авторизованный `gh` с чтением Actions
и полный checkout с commit frontend/backend (`git fetch origin`). Не использовать
production backend checkout `/opt/choral` для переключения на новый main.
Получить фактический backend commit/image из журнала установки/хоста, проверить
изменения frontend относительно установленного API. Значения ниже — placeholders:

```sh
python3 scripts/frontend-delivery.py prepare \
  --run-id <successful-main-push-run-id> \
  --commit <40-hex-frontend-commit> \
  --backend-commit <40-hex-installed-backend-commit> \
  --backend-image sha256:<64-hex-installed-image> \
  --confirm-compatible --output /absolute/new-delivery-directory
```

Результат: `frontend.tar`, `frontend.tar.sha256`, `admission.json` с точными
commit/checksum/run/attempt/API и установленным backend. Каталог должен быть новым.
Никакой npm/build/test suite при получении не запускается. Нет успешного admission,
архив истёк или backend/API несовместим — остановиться, не собирать замену вручную.

Передать эти три файла на хост приватно, сохранить предыдущий release ID для
rollback и доверенный архив предыдущего релиза. После отдельно разрешённой
публикации использовать существующий publish из этого runbook с checksum/commit
из admission, затем короткий smoke:

```sh
python3 scripts/frontend-delivery.py smoke \
  --origin https://choral-train.ru \
  --artifact /absolute/new-delivery-directory/frontend.tar \
  --sha256 <64-hex-checksum-from-admission> \
  --previous-artifact /absolute/saved-previous-release.tar
```

Smoke сверяет байты index/deep link, всех текущих и прежних assets, readiness,
401 для anonymous auth и 404 для неизвестных API/assets. Каждый запрос ограничен
15 секундами. Проверка не отправляет credentials и не создаёт данные. Вход,
прослушивание и действие в ранее открытой вкладке остаются короткой ручной
браузерной приёмкой. При ошибке — существующий rollback, затем smoke со старым
архивом. Разработка #66 не выполняет production deploy или изменение сервера.
