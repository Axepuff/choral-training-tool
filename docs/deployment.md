# Первый запуск на Debian 13 — Issue #16

Статус: первый запуск на velette выполнен, полная production-приёмка не завершена.
Для выбранного ноутбука velette и
домена choral-train.ru используйте [план с существующим Caddy](deployment-velette.md):
владелец настроил DNS, приложение и HTTPS запущены; ограничения и результаты
зафиксированы в дополнении. Nginx ниже —
вариант для отдельного сервера, не инструкция замены Caddy на velette.
Используем существующие
Dockerfile/Compose и backup/restore из [operations.md](operations.md). Go/frontend
имеют один HTTPS origin; Pages остаётся отдельным demo. Автодеплой из GitHub и
доступ к production из CI не нужны для первого ручного релиза.

## Что согласовать после проверки конфигурации

- SSH host/порт/пользователь или доступный SSH alias, возможность sudo. Если под
  «tailwind» имелся в виду Tailscale — имя узла и доступ через существующий tailnet.
  Не пересылать private key, пароль сервера или Tailscale auth key в чат: использовать
  локальный ssh-agent/ключ либо выдать временный доступ публичному SSH-ключу.
- Домен или поддомен (например, choir.example.test), публичный IP/NAT, фактические
  авторитетные DNS-серверы. Регистрация в REG.RU не означает, что DNS обслуживает REG.RU.
  Владелец может сам создать A/AAAA без передачи пароля от регистратора.
- CPU/архитектура, RAM/диск, существующие сайты/контейнеры и занятые 80/443/8080.
  Текущий app ограничен 2 CPU/3 GiB; ОС, nginx, сборке и backup нужен запас сверх этого.
- Окно обслуживания, начальные email двух аккаунтов, место для зашифрованной внешней
  копии, срок хранения, получатель оповещений. Предлагаемый timer — 03:00 UTC ежедневно;
  время и допустимый простой согласовать до включения.
- Отдельное разрешение: установка пакетов, DNS/firewall, TLS, запуск приложения,
  создание аккаунтов и включение timer. Read-only осмотр сервера — отдельный первый шаг.

## Порядок установки после согласования

1. Проверить `/etc/os-release`, `uname -m`, `free -h`, `df -h`, `df -i`,
   `ss -lnt`, состояние Docker/nginx и firewall. Сохранить текущие конфигурации
   приватно. Не выводить env, приватные ключи или полный `docker inspect`.
   Не закрывать SSH/Tailscale при изменении firewall.
2. Установить Engine/Buildx/Compose по [инструкции Docker для Debian 13](https://docs.docker.com/engine/install/debian/).
   Не удалять существующие пакеты/контейнеры автоматически. Проверить `docker info`,
   `docker buildx version`, `docker compose version`; при нужном членстве в группе
   использовать `sg docker`. Пакеты хоста: nginx, certbot, git, curl, util-linux.
   Docker публикует только loopback 8080; публично нужны 80/443. Проверить ограничения
   Docker/firewall по той же инструкции, не полагаться только на UFW.
3. Получить одобренный commit в `/opt/choral` (владелец root, без права записи
   непривилегированных пользователей: systemd выполняет скрипты этого checkout).
   Зафиксировать SHA, успешный PR checks и результаты container smoke. Создать `.env`
   с mode 0600 из `.env.example`: `CHORAL_ORIGIN=https://<домен>`,
   `CHORAL_IMAGE_TAG=<полный-SHA>`, `COMPOSE_PROJECT_NAME=choral`.
   Собирать ровно этот checkout: `docker compose build --pull`.
   Не переиспользовать release tag для другого кода; сохранить image ID через
   `docker image inspect --format '{{.Id}}' choral:<SHA>`.
4. Настроить A на публичный адрес сервера; AAAA добавлять только при рабочем IPv6.
   Проверить публичное разрешение обоих типов и доступность 80 извне (включая NAT).
   Если публичного входа нет, сначала выбрать доступ/NAT либо иной ACME challenge;
   Tailscale сам по себе не делает сайт доступным гостям из интернета.
5. Получить сертификат и поставить proxy по разделу ниже. Затем из `/opt/choral`:

   ```sh
   docker compose up -d --no-build --wait --wait-timeout 90
   curl --fail http://127.0.0.1:8080/readyz
   curl --fail https://<домен>/readyz
   ```

   Проверить redirect HTTP → HTTPS, цепочку сертификата без `-k`, deep links/assets,
   отсутствие внешнего доступа к 8080. Не считать readiness проверкой всех функций.
6. Создать начальные аккаунты через stdin, как в [backend.md](backend.md#локальные-команды-оператора),
   заменив binary на `docker compose exec -T app choral-accounts bootstrap <email>`
   и `create-teacher <email>`. Вводить временные пароли в локальном Bash без echo
   (`read -r -s`), не в argv/env/history; передать владельцам через согласованный
   защищённый канал. Оба пользователя меняют временный пароль через HTTPS UI.
7. Выполнить приёмку ниже, backup и clean restore. Только затем включить timer
   и разрешить обычную эксплуатацию. Не закрывать #16 до фактической приёмки.

## TLS и nginx

[`deploy/nginx.conf`](../deploy/nginx.conf) — полный шаблон **для выделенного nginx**,
с HTTP redirect/ACME webroot, TLS 1.2/1.3, proxy limits и отключёнными access/error logs
на всех listener. На общем сервере сначала подготовить отдельный согласованный
вариант: нельзя заменять чужие virtual hosts. Сохранить требования защиты URL из
[operations.md](operations.md#https-proxy-и-ограничения), включая default server.

Для первого сертификата на свободном порту 80:

```sh
sudo certbot certonly --standalone --cert-name <домен> -d <домен>
```

Если nginx уже запущен, остановка требует согласованного окна; для занятого сервера
предпочтителен webroot существующего HTTP vhost. Не останавливать чужие сайты вслепую.
После получения сертификата заменить все `choir.example.test` в копии шаблона,
установить в `/etc/nginx/nginx.conf`, создать `/var/www/letsencrypt`, выполнить
`sudo nginx -t`, затем start/reload nginx. Ключи остаются только в `/etc/letsencrypt`.

Перевести renewal на webroot без остановки nginx:

```sh
sudo certbot reconfigure --cert-name <домен> --webroot -w /var/www/letsencrypt
sudo certbot renew --dry-run
sudo systemctl enable --now certbot.timer
```

Создать root-owned executable `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx`
с `#!/bin/sh` и `nginx -t && systemctl reload nginx`. Проверить выполнение hook
и состояние timer. Синтаксис/семантика: [Certbot renewal и hooks](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates).
Не использовать nginx-плагин Certbot для автоматической перезаписи проверенного
шаблона логирования. Не добавлять CDN/WAF с журналированием сырых URL.

## Расписание, хранение и восстановление

Сначала выполнить ручной прогон в согласованном окне:

```sh
sudo install -d -m 0700 /var/backups/choral
sudo install -d -m 0755 /usr/local/lib/choral-backup
sudo install -m 0755 scripts/scheduled-backup.sh scripts/backup-restore.sh scripts/copy-backup.sh /usr/local/lib/choral-backup/
sudo install -m 0644 deploy/choral-backup.service deploy/choral-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start choral-backup.service
sudo systemctl status choral-backup.service
```

Скрипт отказывается работать при заранее остановленном app, проверяет graceful exit,
вызывает существующий backup всего volume и возвращает приложение в работу даже
при ошибке архива. Ошибка backup/restart оставляет ненулевой статус service.
В копию добавляются image ID и commit SHA; соответствующий image сохранить отдельно
(`docker image save`) до очистки старых образов. SIGKILL/отключение питания не позволяют
shell trap запуститься: проверить app/health вручную после сбоя обслуживания.

Каждая операция update/restore/accounts должна использовать тот же
`flock /run/lock/choral-maintenance.lock`; не запускать другие writers в обход lock.
Для интерактивного обслуживания: остановить timer, получить lock через
`sudo flock /run/lock/choral-maintenance.lock bash`, перейти в `/opt/choral`, выполнить
операции, выйти из shell и снова включить timer. Timer не запускает пропущенную
ночную копию сразу после boot (`Persistent=false`), чтобы не прерывать дневную работу.

Восстановить копию в отдельный project/пустой volume по [operations.md](operations.md#восстановление-в-чистый-volume),
используя image из IMAGE_ID, тот же origin и другой loopback порт. Для проверки UI
направить запросы тестового клиента на отдельный TLS proxy с тем же origin, не
переключая production traffic. Проверить контрольную песню, media/Range/peaks и
ранее выпущенную ссылку; сессии/ключи копии чувствительны так же, как production.

После успешного restore, согласования всех параметров, проверки второй копии
и доставки тестового уведомления: `sudo systemctl enable --now choral-backup.timer`.
Согласовать retention и зашифрованный вынос **на другое устройство/хранилище**;
локальная копия на том же диске не защищает от потери сервера. Автоудаление пока
не включено: удалять старые копии только после проверки новой и внешней копии.
Ежедневный backup задаёт потенциальную потерю до суток данных; RPO/RTO согласовать
с владельцем, фактическое время восстановления измерить на сервере.

Контроль: внешний HTTPS `/readyz`, свободные bytes/inodes (например, тревога при
<20%), возраст последней завершённой копии >26 часов, failure/duration backup,
certbot timer/срок сертификата, failed jobs и безопасные логи app. Канал оповещения
нужно подключить к мониторингу владельца и проверить тестовой тревогой до приёмки.
Статус systemd сам по себе не доставляет уведомления. Backup age считать только
после SHA256SUMS и успешного service; `.partial` не является копией.

Обновление/rollback: сохранить старый image и полный backup до миграции, закрыть
записи, под lock обновить checkout/tag, запустить `up --no-build --wait`, smoke.
Миграции forward-only: обычный rollback — старый image + pre-update backup в новый
volume; потерю записей после backup согласовать до переключения. Старый volume
сохранять до приёмки. Подробности — [operations.md](operations.md#обновление-rollback-и-диск).

## Приёмка на настоящем origin

- На двух согласованных браузерах/устройствах: login/password change, create,
  upload → настоящий ready, edit/reload, play/pause/seek, loop/metronome, Solo/Mute.
- Чистый гость: song/list links, playback/Range; write запрещён сервером,
  revoked link перестаёт открываться. Не публиковать URL с токенами и cookies.
- Проверить ошибочный/слишком большой upload, отсутствие оригиналов в public
  static, restart persistence, Secure/HttpOnly cookie, отсутствие токенов в логах
  proxy/default/redirect/TLS. Использовать только синтетические токены для проб.
- Проверить backup по расписанию, clean restore и тестовое оповещение; записать
  время, image/commit, контрольные хеши и статусы без приватных данных.
- Только после этого добавить настоящий production URL в README и отчёт #16.
  iPhone проверялся ранее владельцем; это не подтверждение данного HTTPS deployment.
  Android остаётся непроверенным, если отдельно не выполнен.

## Доказательства до доступа к серверу

28 октября 2026: исходная база `2144d154df53798c82999427f85fc11a17bd5e03`.
Дерево совпадает с `c4e72a3596f850a6dbad4ce8430216541e0228d6`, для которого
[PR checks #68](https://github.com/Axepuff/choral-training-tool/actions/runs/40732035448)
успешен: frontend (включая audio browser/stories), backend (включая proxy logs),
e2e (реальный HTTP/SQLite/FFmpeg/browser). Подтверждены run и все steps через GitHub API.
Это full-stack application CI; он не доказывает доступность вашего сервера.

Локально для подготовленной конфигурации прошли:

- `sg docker -c 'sh scripts/check-container.sh'`: build/run, health/routes/assets,
  non-root/read-only, restart/rebuild persistence, scheduled backup с возвратом
  healthy, checksum, SIGTERM и restore в новый пустой volume с чтением записи/файла.
- `python3 scripts/check-scheduled-backup.py`: успех, ошибка архива, exit 137,
  заранее остановленное приложение и ошибка restart. Здесь Docker подменён только
  для fault injection; реальная интеграция проверена предыдущей командой.
- `python3 scripts/check-proxy-logs.py` и `--deployment`: nginx 1.24.0, HTTP и
  настоящий локальный TLS с доверенным временным сертификатом; 200/404/502/413/400
  без токенов в журналах, redirect 308 на фиксированный домен. Это не ACME и не
  версия nginx будущего Debian-хоста; повторить после установки.
- Shell syntax, `systemd-analyze verify` (exit 0, предупреждение о недоступном
  постороннем netplan unit в sandbox), `git diff --check`. Timer не устанавливался.

Первый интеграционный прогон выявил отсутствие `compose start --wait` в Compose
2.40.3; восстановление заменено на `up --no-build --no-recreate --wait`, полный
прогон повторно прошёл. Новые proxy/backup checks добавлены в backend CI.
Production-доступ, DNS/ACME, внешний backup/monitoring и два браузера на реальном
origin остаются этапом после согласования; результаты здесь их не подменяют.


## Продолжение эксплуатации velette

Первичная установка завершена, PR #43 объединён. Не повторять установку.
[Проверка 29 октября](deployment-velette.md#эксплуатационная-проверка--29-октября-2026)
фиксирует restore реальной копии и оставшиеся ограничения. Согласованы 03:00 UTC
(06:00 МСК), перерыв до двух минут, хранение месяц. После подтверждения
тестового письма Beszel timer включён; первый запуск — 30 октября 2026 в 06:00 МСК.
Подготовлена [вторая копия](operations.md#вторая-копия-на-отдельном-диске)
на отдельный HDD после согласования защиты. Автоудаления нет.

Перед включением выбрать канал и проверить **доставку** тестовой ошибки. На хосте
есть Beszel, но наличие контейнеров не доказывает настроенный канал или сбор
статуса backup. Варианты: действующий канал мониторинга владельца, его Telegram-бот
или существующий SMTP; новые аккаунты агент не создаёт. Секреты передаются только
в закрытый локальный конфиг. До подключения канала эти команды — ручной контроль,
а не работающие оповещения:

```sh
curl --fail --max-time 15 https://choral-train.ru/readyz
systemctl show choral-backup.service -p Result -p ExecMainStatus
systemctl list-timers --all choral-backup.timer
df -B1 / /mnt/storage
df -i / /mnt/storage
```

Отдельный внешний наблюдатель нужен для проверки входящей доступности. Проверять
возраст последней **успешной полной** операции с обеими копиями (порог 26 часов),
ошибки service, превышение согласованных двух минут перерыва и свободное место
на обоих дисках. `Result=success` без свежего запуска недостаточен; отсутствие
units — отсутствие расписания. Пороги места и тестовая тревога требуют фиксации
при подключении мониторинга. Проверка renew относится к Caddy, не Certbot.
