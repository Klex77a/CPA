# Сдача Midnight Commit: контрольный час

Нужно загрузить `results/dev/results.json` — 65 диалогов DEV, и `results/prod/results.json` — 10 контрольных чатов. На обработку контрольного набора **и push** отведён один час до стоп-кода. Само сохранение файла или локальный commit не завершает сдачу.

## Подготовить заранее

- Проверьте запуск, подключение модели и доступ к `origin`: `https://github.com/Klex77a/CPA.git`, ветка `main`.
- Отдельно проверьте и опубликуйте готовый код и DEV до выдачи контрольных чатов. Наличие файлов на компьютере не означает публикацию: сверяйте удалённый коммит по инструкции ниже.
- Выполните `npm run check` и `npm test`. Убедитесь, что исходный чек-лист сохранён; эксперименты проводите на его копии.
- Проверьте `git status --short` и отсутствие секретов/исходных разговоров среди публикуемых файлов. Получите точное время стоп-кода у организаторов; оно не отсчитывается автоматически этим приложением.

## 0–5 минут: получить контрольный набор

В разделе **«Диалоги»** введите `group_id` организаторов и нажмите **«Получить из API»**. Резервный вариант — **«Импорт JSON»** сохранённого ответа API. Убедитесь, что загружены именно 10 контрольных чатов.

Во всех командах замените `CONTROL_GROUP` фактическим ID. Если ID содержит пробелы, заключите весь аргумент в кавычки: `"--group=ID команды"`.

## 5–35 минут: оценить и проверить спорные случаи

Сначала посмотрите план: эта команда не обращается к модели.

```sh
node scripts/evaluate-dataset.js --group=CONTROL_GROUP --max-new=10
```

После проверки группы и числа новых оценок запустите обработку через настроенного провайдера:

```sh
node scripts/evaluate-dataset.js --group=CONTROL_GROUP --live --max-new=10
```

Актуальные готовые оценки пропускаются. Не добавляйте `--force` без необходимости. `needs_review` разбирайте в карточке; повтор спорных оценок запускается отдельно с `--retry-review`.

При затяжных тайм-аутах вместо обычной live-команды можно использовать ограниченные настройки только для этого процесса:

```sh
node -e "Object.assign(process.env,{SAMPLES:'1',LLM_TIMEOUT_MS:'60000',LLM_MAX_ATTEMPTS:'2'});require('./scripts/evaluate-dataset').main(process.argv.slice(1)).then(c=>process.exitCode=c).catch(()=>{console.error('Ошибка запуска');process.exitCode=2})" -- --group=CONTROL_GROUP --live --max-new=10
```

Это сокращает ожидание повторов; общего жёсткого дедлайна команда не устанавливает. Следите за временем и оставьте запас на проверку и Git. Ошибки обработки сохраняйте как `status:error`, `criteria:[]`, `score:null` с причиной; не скрывайте ID и не заменяйте ошибку нулевым баллом.

## 35–45 минут: собрать оба файла

```sh
node scripts/prepare-results.js --split=dev
node scripts/prepare-results.js --split=prod --group=CONTROL_GROUP
node scripts/validate-results.js results/dev/results.json --split=dev
node scripts/validate-results.js results/prod/results.json --split=prod
node scripts/check-readiness.js
```

Название команды по умолчанию — **Midnight Commit**. Подготовка файлов не вызывает модель. Проверьте число error-записей. Код 1 у `check-readiness` означает незакрытую проверку; до получения PROD он ожидаем. `valid_with_errors` означает корректный формат с ошибками обработки, требующими внимания.

Подготовка и проверка готовности сверяют файлы с загруженными источниками. Для дополнительной проверки сохранённого ответа API добавьте к `validate-results` аргумент `--source="путь/к/ответу.json"`. Не составляйте путь в `data/datasets` вручную из произвольного `group_id`: имя файла может быть закодировано.

## 45–60 минут: commit, push и подтверждение

```sh
git status --short
git add -- results/dev/results.json results/prod/results.json
git diff --cached --stat
git diff --cached --name-only
```

Просмотрите подготовленные изменения. Если ранее уже были staged-файлы, учитывайте их отдельно: следующая команда включает в commit только два файла результатов, оставляя остальные изменения для отдельной проверки.

```sh
git commit --only -m "Submit DEV and PROD results" -- results/dev/results.json results/prod/results.json
git push origin main
git rev-parse HEAD
git ls-remote origin refs/heads/main
```

Хеш `HEAD` должен совпасть с хешем удалённой `refs/heads/main`. Дополнительно откройте оба файла в GitHub и проверьте число записей. Ошибка push или несовпадение хешей означает, что публикация не подтверждена. Не используйте force-push для обхода конфликта.

Это инструкция для выполнения; она сама не отправляет запросы к модели и не делает commit/push.
