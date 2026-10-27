# UrSim на своём сервере (VPS) с HTTPS

Сайт с игрой и таблицы рекордов работают одним процессом Node.js. Перед ним стоит [Caddy](https://caddyserver.com): он сам получает HTTPS-сертификат от Let's Encrypt и сам его продлевает. Сама игра считается в браузере у игрока, поэтому серверу хватает самого маленького VPS.

Файлы в этой папке:

- `ursim.service` — служба systemd: запускает игру при включении сервера и перезапускает её, если она упала;
- `Caddyfile` — HTTPS для домена;
- `update.sh` — обновление до последней версии из GitHub одной командой.

## 1. Что купить

- **VPS**: Ubuntu 24.04, 1 vCPU, 1–2 ГБ памяти, дата-центр в Германии или Финляндии (ближе всего к игрокам из Европы и СНГ). Например, Hetzner Cloud за €4 в месяц; подойдёт любой провайдер. Цены проверь на сайте.
- **Домен** для HTTPS: свой (около $10 в год) или бесплатный поддомен [DuckDNS](https://www.duckdns.org), например `ursim.duckdns.org`.

## 2. Домен → IP сервера

В панели домена создай **A-запись**: имя `ursim` (или `@` для самого домена) → IP сервера. В DuckDNS впиши IP в поле *current ip*.

Проверка на своём компьютере: `ping ursim.example.com` должен показать IP сервера. Пока этого нет, Caddy не сможет получить сертификат.

## 3. Установка (один раз)

Зайди на сервер с IP и паролем (или SSH-ключом) из панели провайдера:

```bash
ssh root@IP_СЕРВЕРА
```

Дальше все команды выполняются на сервере.

**Обновления системы, git, Caddy и файрвол** (открыты только SSH, HTTP и HTTPS):

```bash
apt update && apt upgrade -y
apt install -y git caddy ufw
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

**Node.js 22:**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

**Пользователь для игры и код.** Игра работает не от root, а от своего пользователя. Код лежит в `/opt/ursim`, рекорды — в `/var/lib/ursim`. Код берётся из публичного репозитория, поэтому пароль GitHub не нужен:

```bash
useradd --system --create-home --home-dir /var/lib/ursim --shell /usr/sbin/nologin ursim
git clone https://github.com/AendeGitHub/UrSimulator.git /opt/ursim
chown -R ursim:ursim /opt/ursim
cd /opt/ursim
sudo -u ursim -H npm ci --include=dev
sudo -u ursim -H npm run build
sudo -u ursim -H npm run build:server
```

**Служба:**

```bash
cp deploy/ursim.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ursim
curl localhost:8787/health
```

Должно получиться что-то вроде `{"ok":true,"uptime":3,"records":"file"}`.

**HTTPS.** Скопируй `Caddyfile` и впиши в нём свой домен вместо `ursim.example.com`:

```bash
cp deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile
systemctl reload caddy
```

Через полминуты игра откроется по адресу `https://твой-домен`. Если сертификат не выдаётся, смотри `journalctl -u caddy -n 50`: обычно домен ещё не указывает на сервер или закрыт порт 80.

## 4. Рекорды

Без настроек рекорды хранятся в файле `/var/lib/ursim/records.json`. Диск VPS, в отличие от бесплатного Render, после перезапуска не стирается.

Если на Render рекорды лежат в Upstash и их нужно сохранить, укажи те же значения на VPS:

```bash
nano /etc/ursim.env
```

```
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
```

```bash
chmod 600 /etc/ursim.env
systemctl restart ursim
journalctl -u ursim -n 5
```

В логе должно появиться `High scores: upstash`.

## 5. Приложение для компьютера

Приложение (Electron) отправляет рекорды на адрес из `PUBLIC_SERVER_URL` в `src/net/records.ts`. Замени его на `https://твой-домен` и выпусти новую версию. Уже установленные копии продолжат ходить на Render, поэтому не выключай Render, пока игроки не обновятся. Ссылки на `ursim.onrender.com` в README тоже стоит заменить.

## 6. Обновление

После `git push` в `main` (в UrSimulator):

```bash
sudo /opt/ursim/deploy/update.sh
```

Скрипт скачает новую версию, соберёт её и перезапустит сервер. Матчи идут в браузерах игроков, поэтому перезапуск их не прерывает.

## Наблюдение

- `https://твой-домен/health` — сервер жив, сколько секунд работает и где хранятся рекорды;
- `journalctl -u ursim -f` — лог сервера в реальном времени.

## Настройки (в `/etc/ursim.env`)

| Переменная | Что делает |
|---|---|
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Рекорды в Upstash вместо файла |
| `RECORDS_FILE` | Где хранить файл с рекордами (служба задаёт `/var/lib/ursim/records.json`) |

После изменения: `systemctl restart ursim`.
