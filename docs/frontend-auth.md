# Frontend: API, сессия и маршруты (Issue #9)

Runtime использует реальный `/api/v1/auth/*`. `src/api/client.ts` — общий typed
fetch-клиент и `ApiError` (status, code, message, requestId, details, Retry-After).
HTTP/невалидный JSON/сеть не превращаются в успешный вход или fixture-данные.
Каждый запрос ограничен таймаутом 30 секунд. `AbortSignal.any` объединяет его
с сигналом вызывающего кода: отмена при уходе со страницы сохраняется, а зависший
public-запрос завершает загрузку ошибкой с предложением обновить страницу.
Ответ auth проверяется перед установкой идентичности; роль берётся только с сервера.
Пароль передаётся только в JSON login/password, непрозрачная сессия — HttpOnly cookie.
CSRF хранится только в памяти, приходит из login/me и отправляется в session writes.
Ни localStorage, ни sessionStorage, ни URL для пароля/сессии не используются.

`src/auth/session.ts` хранит один снимок для `useSyncExternalStore`.
Старт/reload, возврат фокуса/видимости и истечение сессии вызывают me; до подтверждения
редакторские действия скрыты. При фоновой проверке SignIn и ChangePassword
сохраняют экземпляр формы и введённые значения; сетевая ошибка фонового me
не стирает эти формы. Первичная ошибка восстановления по-прежнему показывает retry.
Повторные focus/visibility события объединяются, а во время login/logout/password
новый me не запускается. Auth-операция делает ответы ранее начатого me устаревшими,
включая 401: только актуальная проверка может изменить профиль и CSRF.
401 остальных приватных API убирает пользователя и CSRF.
401 login означает неверные данные (включая блокировку), не успех.
CSRF failure перечитывает me; исходный write **не повторяется автоматически**.
После ошибки можно повторить действие. Logout снимает права после настоящего
204/401; ошибка сети оставляет сессию и показывает возможность повторить выход.
Счётчик поколений не позволяет позднему успешному me восстановить завершённую сессию.
Ошибка старого запроса не сбрасывает новый CSRF/пользователя.
Временный пароль открывает обязательную смену через PUT /auth/password; после
отзыва всех сессий требуется повторный вход. Раздел управления аккаунтами не добавлен.

## Навигация и границы #10/#11

- `?page=sign-in`, `?page=library`, `?page=create-song`, `?page=edit-song&id=<uuid>`.
  Приватный адрес без сессии показывает SignIn и после входа восстанавливает
  разрешённый маршрут. `returnTo` принимает только allowlist query-маршрутов;
  абсолютные/внешние URL, вложенный redirect и лишние параметры отбрасываются.
- `?list=<token>` и `?song=<token>` имеют приоритет над page/role/owner.
  Всегда гостевые, даже с действующей cookie. Запрос public API делает credentials=omit.
  Неверная/отозванная ссылка и network error показывают ошибку, а не форму входа
  или демо-песни. Список читает все страницы snapshot перед поиском/сортировкой.
  Переход из списка сохраняет token и добавляет `id` песни.
- Публичный адаптер отображает серверные метаданные и названия дорожек без
  редактирования. Воспроизведение явно помечено как ещё не подключённое (#11).
- После входа открывается оболочка «Песни» с серверными email/ролью и logout.
  Личный список, создание и редактирование явно сообщают, что данные/сохранение
  пока не подключены: полноценные songs/forms/shares/uploads adapters — #10.
  Пустой серверный список и успешное сохранение не имитируются.

Компонент SongLibrary больше не выбирает fixtures по умолчанию: stories и DemoApp
передают `mockSongs` явно. Runtime не импортирует демонстрационный плеер/модель песен.

## Локальный запуск и production

```sh
# Backend: Go/toolchain и команды accounts — docs/backend.md.
# Только локальные HTTP cookies; реальных credentials не требуется для описания setup.
CHORAL_ADDR=127.0.0.1:8080 CHORAL_ORIGIN=http://127.0.0.1:5173 \
  CHORAL_LOCAL_HTTP=true CHORAL_DATA_DIR=/tmp/choral-dev-data /tmp/choral-server
# Другой терминал, корень проекта:
npm ci --cache /tmp/choral-npm-cache --no-audit --no-fund
npm run dev
```

Vite проксирует `/api` на `http://127.0.0.1:8080`, сохраняя браузерный Origin;
backend CHORAL_ORIGIN должен совпадать с origin **Vite**, а не адресом upstream.
Не смешивать localhost/127.0.0.1. Для тестового upstream допустим серверный
`CHORAL_API_PROXY=http://127.0.0.1:<port>`; это настройка Vite, не браузерный API URL.
Оператор создаёт аккаунты CLI с приватным stdin по backend-инструкции.

`npm run build` — реальный runtime. Production обслуживает dist и `/api/v1`
на одном HTTPS origin; CHORAL_ORIGIN — этот origin без завершающего `/`.
Cookie остаётся Secure; CORS и API-ключи не нужны. Завершение TLS и раздача dist — #14.
HTML содержит referrer=no-referrer для публичных токенов.

Pages workflow собирает `VITE_APP_DEMO=true npm run build`: это явно обозначенная
демонстрация (title «Демонстрация · Хор»), которая не отправляет пароль и не обращается к auth API.
Storybook использует те же компоненты с явными fixtures. Режим определяется
при сборке, не query-параметром и не ошибкой backend. Для локальной сборки Pages:

```sh
VITE_APP_DEMO=true npm run build
npm run build-storybook
node scripts/assemble-pages.mjs
```

## Поведенческие проверки

```sh
npm run test:auth
# Сначала собрать Storybook и demo Pages командами выше.
# Go 1.27.3 в PATH; Chrome доступен по /usr/bin/google-chrome
# или CHROME_BIN; нужны установленные npm dependencies.
GOCACHE=/tmp/choral-gocache GOPATH=/tmp/choral-gopath npm run test:auth:browser
```

Первая команда проверяет клиент, ошибки, credentials/CSRF, маршруты, stale response,
пагинацию public и отсутствие fallback с управляемыми ответами fetch.
Регрессии покрывают focus во время login и устаревший me 401 до/после его успеха.
Дополнительно проверяются зависший public fetch с переданным signal, таймаут,
отмена вызывающим кодом и успешный повтор без fallback.
Вторая запускает настоящий Go auth/sharing с SQLite в t.TempDir(), вымышленными
аккаунтами и синтетическими public metadata fixtures, затем Vite proxy и headless
Chrome через CDP. Проверяет неверный пароль, login/reload/logout, отзыв, сеть,
блокировку, обязательную смену пароля, безопасный возврат, public routes с forged
role/page, отсутствие browser storage и overflow на 320/360/landscape/desktop.
Регрессия мобильной адаптации использует непрерывные серверные строки:
название 160 символов, дорожку 80, заметку 1000 и длинный допустимый email.
Проверяет public song, песню из public list и профиль после входа на
320×640, 360×800, 800×360 и 1280×900: полное содержимое, границы текстовых
фрагментов и отсутствие горизонтального переполнения. Общий контейнер
наследует `overflow-wrap: anywhere`; текст переносится без скрытия overflow.
Эти сценарии, 17 stories с play, auth tests, runtime/demo build, Storybook build,
lint и assemble-pages повторно проверены при исправлении замечания P2 к #9.
Отдельно задерживает настоящие ответы me/login: проверяет сохранение полей
SignIn/ChangePassword при focus и visibilitychange, сохранение формы во время
незавершённого login и отсутствие конкурирующего me.
Браузерная регрессия имитирует зависший public transport с сокращённым таймаутом,
проверяет исчезновение загрузки и сообщение о повторе; после reload без имитации
получает метаданные настоящего Go sharing API.
Также запускает 17 затронутых stories с ожиданием storyFinished (включая play)
и проверяет demo SignIn без отправки данных. Production БД/cookies/credentials не читаются. HTTP управляющий endpoint блокировки
существует только внутри этого теста. Обычный go test пропускает браузерный запуск.

Проверено в локальной sandbox для результата #9: `npm ci`, typecheck, lint,
обычная runtime build и demo build, build-storybook, assemble-pages,
`npm run test:auth` (15 проверок, включая родительскую), `npm run test:auth:browser` (реальный Go API,
Chrome, 17 stories с play и Pages demo), `go test ./internal/auth ./internal/sharing`,
`git diff --check`. Использованы Node 24.19.0 и Go 1.27.3 из локального toolchain.
Storybook сохраняет предупреждение о размере bundle; сборка успешна.

## Обновление Issue #10

Личный список/создание/редактирование уже подключены к Go API; исторический
раздел о заглушках выше больше не описывает runtime. См.
[frontend-songs.md](frontend-songs.md). Формы сохраняют экземпляр при background
me; временная ошибка me оставляет предыдущую session и показывает явный banner,
чтобы offline не уничтожал несохранённые данные. Все записи по-прежнему проверяет
сервер, 401 снимает session. Query-кодирование допускает пробелы/пунктуацию поиска,
но endpoint остаётся относительным same-origin без обхода пути.
