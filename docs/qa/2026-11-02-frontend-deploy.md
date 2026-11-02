# Проверки независимого frontend deploy — #65

Локальная проверка 2 ноября 2026. Использованы Node 24.19.0, Go 1.27.3,
Python 3.13, Chrome for Testing Headless 156.0.8078.80 и локальный Docker.
Go/Node загружены в `/tmp` с проверкой SHA-256; production toolchain не менялся.
Новые зависимости, изменения UI, API/миграций и workflows отсутствуют.

## Подтверждённое поведение

- `go test ./internal/platform -run TestFrontend -count=1`: routes/deep links,
  404 assets/API/private/dotfiles, HEAD, revalidation HTML, content ETag/304,
  смена symlink у уже созданного handler, immutable cache только существующих assets.
- `check-frontend-release.py --server /tmp/issue65-server`: **8/8 pass, 0 skip**.
  Два релиза и rollback на одном настоящем Go/SQLite/FFmpeg процессе;
  новые/старые assets, Range, index/deep links, 401/no-store для гостевого auth API;
  PID остаётся тем же, содержимое и mtime всех файлов временного private data
  совпадают до/после frontend-операций. Проверены неполный upload, неверная checksum,
  inventory/hash/demo/base/API/approved commit, unsafe tar paths/symlinks,
  immutable collision, повреждённый rollback, competing publish/rollback через
  отдельный процесс с удерживаемым flock, retention/dry-run/очистка,
  отказ смешанного private каталога, права каталогов под umask 077 и snapshot restore.
- `check-frontend-container.py` с локальным runtime image
  `sha256:f34ae21a63915c21f0bafcd341378b16941e6fb9bd2cafdfdfa4a4b00444d30a`
  и read-only mount нового Go binary: **pass**. Использует случайный Compose project,
  собственный новый volume и динамический loopback port. Проверены реальный
  `compose.yaml` + `compose.frontend.yaml`, read-only parent bind и UID 10001;
  однократное пересоздание с сохранением схемы/migration records/private marker,
  затем publish → rollback **без изменения container ID, Go PID, RestartCount и
  хешей private файлов**. Переход обратно на bundled `/app` также проверен.
- В том же сценарии **настоящая вкладка Chrome** остаётся открытой при publish
  и rollback, продолжает исполнять старый JS, запрашивает прежний asset с отключённым
  browser cache, читает новый index/API, получает asset нового релиза после rollback,
  затем reload/deep link успешны. Это синтетические HTML/JS fixtures для контракта
  доставки; полный UI/audio suite и физические устройства здесь не проверялись.
- Отдельный этап этого disposable Compose-сценария вызывает настоящий
  `backup-restore.sh`: backup включает frontend.tar/FRONTEND.json/SHA256SUMS;
  затем новый frontend root + чистый private volume восстанавливают исходные
  index/assets/private marker. Это **отдельная** операция, deploy её не вызывает.
- `check-restore-acceptance.py <image-id> --frontend`: **pass**. Изменённый production
  restore helper разворачивает внешний frontend из snapshot в отдельном project,
  проверяет его HTML, вымышленные прежние song/list ссылки, media hash/Range и peaks.
- `check-scheduled-backup.py`: **8/8 pass**, включая новый frontend snapshot и
  его отказ с возвратом app в работу; незавершённая копия не получает SHA256SUMS.
- `check-backup-copy.py`, `check-backup-health.py`, `check-backup-retention.py`: **pass**,
  включая перенос/контроль frontend и отказ при его повреждении. Старый формат
  backup также сохранён. `sh -n`, Python compile, lint и `git diff --check`: **pass**.
- `frontend-release.py build` на чистом `f8de2b686ec157a7953b51cd4c0bbda2b4c41845`
  прошёл: production dist с `VITE_APP_DEMO=false`, `CHORAL_BUILD_BASE=/`,
  Vite manifest, typecheck и tar. SHA-256 артефакта:
  `36481dee1700655a8a6fff0d7f7787be4fa6c1953901133e3144758fb7c407c3`.
  Готовый tar опубликован в ещё один временный root; проверены байты **всех**
  файлов, immutable cache JS/CSS/worker/fonts и настоящий экран входа React в
  Chrome. Существующие license/source файлы Jost включены. Артефакт остаётся
  вне Git; следующий commit обновляет только этот QA-отчёт.

Все случайные Compose projects/volumes удаляются в `finally`. Production checkout,
app, private volume, БД, Caddy, systemd/timers и размещённый frontend не менялись.
Доступность внешнего HTTPS и реальные пользовательские вкладки не проверялись.
Backend runtime image не пересобирался: тест использует имеющийся FFmpeg image и
новый Go binary из исходников этой ветки. Полный image build/прочие backend suites,
Storybook/audio/e2e и remote CI вручную не запускались: поведение их областей
не менялось. CI-фильтрация и автоматическая доставка остаются #66.
