# План разработки и GitHub Issues

Список ниже — план работ; текущий статус смотрите в GitHub. Создание Issue не означает,
что функция уже реализована. [PR #17 — передача документации](https://github.com/Axepuff/choral-training-tool/pull/17)
уже объединён. Реализацию можно выполнять по очереди ниже.
Общий трекер: [#1](https://github.com/Axepuff/choral-training-tool/issues/1). Он содержит подзадачи и не предназначен одному агенту целиком.

## Backlog

| Issue | Задача | Начать после | Для завершения дополнительно |
| --- | --- | --- | --- |
| [#2](https://github.com/Axepuff/choral-training-tool/issues/2) | MVP-01: Контракты API, данных, аудио и прав доступа | — | — |
| [#3](https://github.com/Axepuff/choral-training-tool/issues/3) | MVP-02: Каркас Go, SQLite, миграции и проверки PR | [#2](https://github.com/Axepuff/choral-training-tool/issues/2) | — |
| [#4](https://github.com/Axepuff/choral-training-tool/issues/4) | MVP-03: Email/пароль, сессии, роли и bootstrap аккаунтов на Go | [#3](https://github.com/Axepuff/choral-training-tool/issues/3) | — |
| [#5](https://github.com/Axepuff/choral-training-tool/issues/5) | MVP-04: API песен и дорожек с сохранением и проверкой владельца | [#3](https://github.com/Axepuff/choral-training-tool/issues/3) | [#4](https://github.com/Axepuff/choral-training-tool/issues/4) |
| [#6](https://github.com/Axepuff/choral-training-tool/issues/6) | MVP-05: Публичные ссылки на песню/список и защищённое чтение медиа | [#4](https://github.com/Axepuff/choral-training-tool/issues/4), [#5](https://github.com/Axepuff/choral-training-tool/issues/5) | — |
| [#7](https://github.com/Axepuff/choral-training-tool/issues/7) | MVP-06: Загрузка аудио, файловое хранилище и проверка FFprobe | [#4](https://github.com/Axepuff/choral-training-tool/issues/4), [#5](https://github.com/Axepuff/choral-training-tool/issues/5) | — |
| [#8](https://github.com/Axepuff/choral-training-tool/issues/8) | MVP-07: FFmpeg worker, playback-файлы, peaks и удаление оригиналов | [#7](https://github.com/Axepuff/choral-training-tool/issues/7) | — |
| [#9](https://github.com/Axepuff/choral-training-tool/issues/9) | MVP-08: Frontend API-клиент, сессия и навигация после входа | [#2](https://github.com/Axepuff/choral-training-tool/issues/2) | [#4](https://github.com/Axepuff/choral-training-tool/issues/4) |
| [#10](https://github.com/Axepuff/choral-training-tool/issues/10) | MVP-09: Подключить список, создание, редактирование, загрузку и ссылки к API | [#2](https://github.com/Axepuff/choral-training-tool/issues/2) | [#5](https://github.com/Axepuff/choral-training-tool/issues/5), [#6](https://github.com/Axepuff/choral-training-tool/issues/6), [#8](https://github.com/Axepuff/choral-training-tool/issues/8), [#9](https://github.com/Axepuff/choral-training-tool/issues/9) |
| [#11](https://github.com/Axepuff/choral-training-tool/issues/11) | MVP-10: Реальный синхронный многодорожечный плеер | [#2](https://github.com/Axepuff/choral-training-tool/issues/2) | [#6](https://github.com/Axepuff/choral-training-tool/issues/6), [#8](https://github.com/Axepuff/choral-training-tool/issues/8) |
| [#12](https://github.com/Axepuff/choral-training-tool/issues/12) | MVP-11: Выбор тактов повтора и рабочий метроном | [#11](https://github.com/Axepuff/choral-training-tool/issues/11) | — |
| [#13](https://github.com/Axepuff/choral-training-tool/issues/13) | NEXT-01: Управление аккаунтами администратора: API и компактный UI | [#4](https://github.com/Axepuff/choral-training-tool/issues/4), [#9](https://github.com/Axepuff/choral-training-tool/issues/9) | — |
| [#14](https://github.com/Axepuff/choral-training-tool/issues/14) | MVP-12: Контейнерный запуск, постоянные данные и проверяемое восстановление | [#3](https://github.com/Axepuff/choral-training-tool/issues/3) | — |
| [#15](https://github.com/Axepuff/choral-training-tool/issues/15) | MVP-13: Сквозные проверки полного приложения и прав в CI | [#4](https://github.com/Axepuff/choral-training-tool/issues/4), [#5](https://github.com/Axepuff/choral-training-tool/issues/5), [#6](https://github.com/Axepuff/choral-training-tool/issues/6), [#8](https://github.com/Axepuff/choral-training-tool/issues/8), [#9](https://github.com/Axepuff/choral-training-tool/issues/9), [#10](https://github.com/Axepuff/choral-training-tool/issues/10), [#11](https://github.com/Axepuff/choral-training-tool/issues/11), [#12](https://github.com/Axepuff/choral-training-tool/issues/12), [#14](https://github.com/Axepuff/choral-training-tool/issues/14) | — |
| [#16](https://github.com/Axepuff/choral-training-tool/issues/16) | MVP-14: Разместить первую рабочую версию на сервере | [#15](https://github.com/Axepuff/choral-training-tool/issues/15), [#14](https://github.com/Axepuff/choral-training-tool/issues/14) | — |

Зависимость означает принятый и объединённый контракт/код, а не просто созданный PR.
Frontend/audio задачи с ранним стартом могут идти на контрактных fixtures; закрывать их до реальной интеграции нельзя.

## Рекомендуемый запуск агентов

1. **Первый агент:** [#2](https://github.com/Axepuff/choral-training-tool/issues/2) — общий API, данные, timing и права. До этого не выдавать разным агентам независимое проектирование API.
2. После контракта параллельно: **Go foundation** [#3](https://github.com/Axepuff/choral-training-tool/issues/3) и **frontend client/session** [#9](https://github.com/Axepuff/choral-training-tool/issues/9) на контрактных ответах. Audio engine [#11](https://github.com/Axepuff/choral-training-tool/issues/11) можно отдельно начать на fixtures, если есть третий агент.
3. После foundation параллельно: **auth** [#4](https://github.com/Axepuff/choral-training-tool/issues/4), **songs** [#5](https://github.com/Axepuff/choral-training-tool/issues/5) и **контейнерный запуск/backup** [#14](https://github.com/Axepuff/choral-training-tool/issues/14). Songs использует согласованный identity interface и завершается после auth.
4. После auth/songs параллельно: **sharing** [#6](https://github.com/Axepuff/choral-training-tool/issues/6) и **uploads/probe** [#7](https://github.com/Axepuff/choral-training-tool/issues/7). Затем **processing worker** [#8](https://github.com/Axepuff/choral-training-tool/issues/8) после uploads.
5. **Реальная интеграция форм/списка** [#10](https://github.com/Axepuff/choral-training-tool/issues/10) и финальная интеграция **audio player** [#11](https://github.com/Axepuff/choral-training-tool/issues/11) идут в разных областях. У каждой задачи соблюдаются её дополнительные зависимости.
6. **Диапазон повтора/метроном** [#12](https://github.com/Axepuff/choral-training-tool/issues/12) — после player, а не параллельно с правками того же движка.
7. **Сквозная проверка** [#15](https://github.com/Axepuff/choral-training-tool/issues/15) → **размещение на сервере** [#16](https://github.com/Axepuff/choral-training-tool/issues/16). Для последнего потребуются данные хостинга/домена от владельца.
8. **Админский интерфейс** [#13](https://github.com/Axepuff/choral-training-tool/issues/13) можно делать отдельно после auth/client. Это NEXT: первый релиз может обойтись CLI для двух начальных аккаунтов.

## Границы параллельной работы

- Контракт и общие схемы принимает один поток; остальные его используют.
- Auth, songs, sharing, uploads и processing имеют свои backend-пакеты и согласованные interfaces.
- Go foundation владеет первоначальным CI/миграционным каркасом. Следующие миграции добавляются по его правилам.
- Frontend session/navigation владеет `src/main.tsx`/router; forms/library не должны параллельно переписывать этот файл без согласования.
- Player/audio и range/metronome выполняются последовательно: у них общие файлы.
- Один PR не объединяет соседние Issues; агент фиксирует, что реализовал и что осталось зависимому потоку.

## Что передать агенту

```text
Репозиторий Axepuff/choral-training-tool, актуальный main.
Выполни Issue #2 (или другой выбранный номер).
Сначала прочитай AGENTS.md, docs/handoff.md, docs/architecture.md,
docs/authentication.md и саму Issue с её зависимостями.
Создай отдельную ветку и PR с Closes #N, проверками и ограничениями.
Согласованный дизайн сохраняй; соседние задачи не включай.
```

Правила новых чатов и субагентов: [agent-workflow.md](agent-workflow.md).
Последовательная локальная очередь с автоматическим ревью/merge: [local-automation.md](local-automation.md).
Текущее состояние макетов: [handoff.md](handoff.md).

## Локальный результат Issue #4

Реализованы Go auth/identity/authorizer, bootstrap и восстановление оператора,
смена/сброс временного пароля и поведенческие HTTP/SQLite тесты. Это не означает
завершения #9 (подключение frontend) или #13 (CRUD/UI аккаунтов). Commit/PR/merge
этого результата выполняет контроллер очереди.

## Локальный результат Issue #5

Реализованы приватные CRUD песен/дорожек, SQLite persistence, real auth/ownership,
Unicode validation, version conflict/rollback, поиск/сортировка и snapshot cursor,
идемпотентное создание и логическое удаление с отменой jobs. Документация и
поведенческие тесты — [backend.md](backend.md#песни-и-дорожки-issue-5).
Публичные endpoints #6, upload #7, обработка/уборщик #8 и frontend #10 остаются
отдельными задачами. Commit/PR/merge выполняет контроллер очереди.

## Локальный результат Issue #6

Реализованы sharing CRUD/rotation/revocation, encrypted replay, public song/list
snapshots, единая область доступа к метаданным/media и HTTP GET/HEAD/Range/peaks.
Проверки используют настоящие auth/SQLite и Storage fixtures; подключение реального
Storage — #7, интеграция с worker — #8, UI — #10. Подробнее:
[backend.md](backend.md#публичные-ссылки-и-media-issue-6). Commit/PR/merge остаются
контроллеру очереди.

## Локальный результат Issue #7

Реализованы streaming upload, private Storage, FFprobe metadata/decoder validation,
quota/admission/timeouts, durable jobs и статусы, version/live ownership checks,
replay и очистка незавершённых/crash файлов. Поведенческие тесты используют
реальные синтетические audio fixtures и SQLite/FS/auth. Worker/full decode/
публикация результата/периодический cleaner — #8, UI — #10. Документация:
[backend.md](backend.md#загрузка-и-приватное-хранилище-issue-7).
Commit/PR/merge выполняет контроллер очереди.

## Локальный результат Issue #8

Реализованы SQLite worker/lease/retry, bounded FFmpeg, настоящие playback и peaks,
атомарная замена active asset и cleanup после commit с grace/failed retention.
Поведенческие проверки включают SIGKILL/restart во время реальной обработки и
upload → worker → public media. Проверены Go 1.27.3, FFmpeg 6.1.1 и локальная сборка 7.1.5;
поставляемые binary нужно повторно проверить в среде #14. Документация:
[backend.md](backend.md#обработка-аудио-issue-8). Commit/PR/merge — контроллеру.

## Локальный результат Issue #9

Реализованы typed API client, серверная сессия/login/logout/me/CSRF/401,
password gate, безопасная навигация и независимые guest routes, dev proxy и
явная Pages demo сборка. Go/SQLite + Chrome integration использует вымышленные
fixtures; runtime fallback на моки отсутствует. Songs/forms — #10, звук — #11.
Документация: [frontend-auth.md](frontend-auth.md). Commit/PR/merge — контроллеру.
