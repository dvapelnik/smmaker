# SMMaker - Sitemap generator

Вариант решения задания отборочного этапа UaWebChallenge VII для Middle/Senior BackEnd разработчика

---

Проверено на сайтах:

* http://uawebchallenge.com/
* http://eu.wikipedia.org/
* http://ru.wikipedia.org/
* http://www.w3.org/
* http://www.sitemaps.org/
* http://javascript.ru/
* http://backbonejs.org/
* https://xakep.ru/
* http://habrahabr.ru/
* https://toster.ru/
* http://www.linux.org/
* http://www.reddit.com/
* http://www.nytimes.com/
* https://github.com/
* http://deadlock.org.ua/
* http://pmg17.vn.ua/
* http://vinnicya.vn.ua/
* http://www.phys.univ.kiev.ua/
* http://www.razom.org.ua/
* http://dorobok.edu.vn.ua/

---

Для того, чтобы работала отправка через EMAIL нужно указать логин и пароль для ящика GMail а файле `server/config.js`

Коротко о принципе работы:
Каждый URI - это объект типа `Uri(uri, level)`
Есть три пулла:
1. Пулл очереди, куда скидываются распарсенные ссылки
2. Пулл воркеров, куда помещаются объекты HTTP-запросов для получения HTML контента
3. Пулл Сайтмапа, в который скидываются URI-шки для создания сайтмапа

Все работает по событийной схеме

1. Стартуем
2 .Добавляем главную ссылку в пулл очереди и генерируем событие удаления воркера из пулла воркеров
3. Событие отлавливается своим слушателем, который должен создать воркера (http запрос), запустить его и по получению ответа сгенерировать событие, что он получил ответ и передать с ним HTML-ку
4. Событме ловится и дальше
  1. обработанная URI-шка добавляется в пулл сайтмапа
  2. удаляется URI-шка из пулла очереди
  3. если запрос не прерван (его HTML можно парсить и получать новые ссылки) и при этом можно парсить на дальнейшую глубину вложенности, то парсим ответ, выуживаем ссылочки, приводим их к красивому виду и фильтруем (нет ли таких ссылок среди обоботанных, обрабатываемых сейчас и ожидающих в очереди) если что-то осталось, то добавляем их в пулл, увеличив уровень вложенности на единицу
И все это продолжается пока пулл очереди не опустеет
  4. eсли пулл воркеров и пулл очереди опустели, то генерируем событие о том, что получение ссылок завершено и можно генерировать файл сайтмапа
Генерируем сайтмап
  5. eсли количество ссылок или его ожидаемый объем превышает лимиты (по количеству ссылок в файле и по объему файлов), то его нужно разделить
  6. eсли нужно, то делим и генерируем порционные сайтмапы и главный сайтмап с линками на их
5. по завершению генерации отправляем сайтмап получателю: либо клиенту в браузер и показываем его ссылочками, либо почтой
6. генерация XML всегда производится с сохранением на диск. На этапе отдачи его польователю просто отдаются либо статической ссылокй на ресурс, либо отправляются все файлы из соответствующей папки (папка именуется как текущий unix timetamp)

## Перенаправление
Если встречается статус `>300` и `<400`, то следуем за переаправлением и передаем в работу только последнюю URI

## P.S.
Универсальный генератор сайтмапа сложно написать и потому следует писать под какой-то отдельный ресурс или тип ресурсов, который опирается не на распарсивание страниц, а на сами данные