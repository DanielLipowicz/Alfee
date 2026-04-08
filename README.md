# Alfee - zadania z logowaniem lokalnym/Google i tenantami

Aplikacja webowa z trzema rolami:

- `admin`:
  - tworzy organizacje,
  - edytuje i usuwa organizacje,
  - zarzadza rolami uzytkownikow (admin/kierownik/pracownik),
  - moze wejsc w tryb kierownika dla wybranej organizacji i korzystac z panelu `/manager/*`,
  - przypisuje kierownikow i pracownikow do organizacji,
  - zarzadza czlonkostwami w tenantach.
- `manager`:
  - przelacza aktywna organizacje,
  - tworzy lokalne konta pracownikow i automatycznie przypisuje je do aktywnej organizacji,
  - tworzy, kopiuje, edytuje i usuwa zadania tylko w aktywnej organizacji,
  - przydziela zadania pracownikom nalezacym do tej samej organizacji,
  - sledzi postep i zdjecia dowodowe.
- `employee`:
  - przeglada swoje przydzielone zadania (takze z wielu organizacji),
  - odznacza czynnosci jako ukonczone,
  - dodaje zdjecia jako dowody wykonania.

## Autoryzacja

- Rejestracja lokalna: `email + imie i nazwisko + haslo` (konto domyslnie aktywne).
- Logowanie lokalne: `email + haslo`.
- Hasla sa haszowane algorytmem `scrypt`.
- Po wielu nieudanych probach logowania konto jest czasowo blokowane.
- Logowanie Google OAuth 2.0 (opcjonalnie, jesli skonfigurowane w `.env`).

## Stack

- Node.js + Express
- SQLite
- EJS (SSR)
- Passport (sesje) + Google OAuth 2.0

## Uruchomienie

1. Zainstaluj zaleznosci:

```bash
npm install
```

2. Utworz plik `.env` na podstawie `.env.example`.

3. (Opcjonalnie) W Google Cloud Console skonfiguruj OAuth:

- utworz `OAuth Client ID` typu `Web application`,
- dodaj `Authorized redirect URI`:
  - `http://localhost:3000/auth/google/callback`

4. Uruchom aplikacje:

```bash
npm run dev
```

lub

```bash
npm start
```

5. Otworz: `http://localhost:3000`

## Role uzytkownikow

- `ADMIN_EMAILS`: konta z tej listy sa promowane do roli `admin` przy logowaniu.
- `MANAGER_EMAILS`: konta z tej listy sa promowane do roli `manager` przy logowaniu.
- Administrator moze recznie zmieniac role uzytkownikow z panelu.
- Pozostali uzytkownicy domyslnie dostaja role `employee`.
- Jesli obie listy sa puste, pierwszy zalogowany uzytkownik zostaje kierownikiem (fallback developerski).

## Tenanty

- Kazda organizacja ma osobny zestaw zadan.
- Kierownik widzi i modyfikuje tylko dane aktywnej organizacji.
- Kierownik moze nalezec do wielu organizacji i przelaczac tenant z poziomu naglowka.
- Pracownik moze nalezec do wielu organizacji i widzi swoje zadania z przypisanych tenantow.

## Struktura danych

- `users`
- `organizations`
- `user_organizations`
- `tasks`
- `task_steps`
- `assignments`
- `assignment_steps`
- `step_evidence`
- `notifications`

## Uwagi produkcyjne

- Ustaw silny `SESSION_SECRET`.
- Za reverse proxy/HTTPS ustaw `secure` cookie i `trust proxy`.
- Rozwaz przeniesienie uploadow do obiektu storage (S3/GCS) i dodanie limitow/antywirusa.

## ERR_SSL_PROTOCOL_ERROR na telefonach (naprawa)

Ten projekt nasluchuje HTTP (`node server.js`), wiec blad `ERR_SSL_PROTOCOL_ERROR` zwykle oznacza, ze klient laczy sie po `https` do portu bez TLS (np. `:20120`) albo serwer TLS wysyla niepelny lancuch certyfikatow.

Szybkie rozwiazanie:

1. Wystaw HTTPS na `:443` przez reverse proxy (Caddy/Nginx) i proxy do `http://127.0.0.1:20120`.
2. Ustaw pelny lancuch certyfikatu (`fullchain.pem`, nie samo `cert.pem`).
3. W `.env` ustaw:

```env
TRUST_PROXY=1
SESSION_COOKIE_SECURE=auto
FORCE_HTTPS=true
GOOGLE_CALLBACK_URL=https://twoja-domena/auth/google/callback
```

Przyklad Caddy (najprostszy):

```caddy
twoja-domena.pl {
  reverse_proxy 127.0.0.1:20120
}
```

Przyklad Nginx (TLS + pelny lancuch):

```nginx
server {
  listen 443 ssl http2;
  server_name twoja-domena.pl;

  ssl_certificate /etc/letsencrypt/live/twoja-domena.pl/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/twoja-domena.pl/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:20120;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Jesli nadal problem wystepuje tylko na mobile, najpierw sprawdz czy nie otwierasz `https://...:20120` zamiast domeny na `443`.

## License and Copyright

This software is provided "AS IS" and you use it at your own risk.
All copyrights and rights to the software belong to:
**Check-IT Daniel Lipowicz**.

The full license terms are available in `LICENSE.md`.

## Deploy "as code" na VPS Linux (ultra low RAM, bez Dockera)

Docelowy adres aplikacji:
- aplikacja backend: `http://127.0.0.1:20120` (wewnetrznie),
- publicznie: `https://twoja-domena/` przez reverse proxy na `443`.
- port `20120` jest wymuszony w skryptach deploy.

### Alpine Linux (OpenRC) - rekomendowane dla Twojego VPS

1. Sklonuj repo i uruchom instalator:

```bash
git clone <URL_TWOJEGO_REPO> alfee
cd alfee
chmod +x deploy/lowram/install-alpine.sh deploy/lowram/update-alpine.sh
./deploy/lowram/install-alpine.sh
```

2. Ustaw `.env`:

```bash
nano .env
```

Minimum:

```env
PORT=20120
SESSION_SECRET=tu-bardzo-mocny-losowy-sekret
GOOGLE_CALLBACK_URL=https://twoja-domena/auth/google/callback
```

Jesli nie uzywasz Google OAuth, pozostaw `GOOGLE_CLIENT_ID` i `GOOGLE_CLIENT_SECRET` puste.

3. Restart po zmianie `.env`:

```bash
rc-service alfee restart
```

4. Sprawdzenie:

```bash
rc-service alfee status
tail -n 100 /var/log/alfee.log
tail -n 100 /var/log/alfee.err
```

5. Aktualizacja aplikacji:

```bash
./deploy/lowram/update-alpine.sh
```

### Alpine - naprawa bledu sqlite3 (`ERR_DLOPEN_FAILED`)

Jesli pojawi sie blad ladowania `node_sqlite3.node`, wykonaj:

```bash
cd /home/frog/Alfee
rc-service alfee stop || true
rm -rf node_modules
npm cache clean --force
npm_config_jobs=1 npm_config_progress=false npm_config_loglevel=warn NODE_OPTIONS=--max-old-space-size=128 npm ci --omit=dev --no-audit --no-fund
npm_config_jobs=1 npm_config_progress=false npm_config_loglevel=warn NODE_OPTIONS=--max-old-space-size=128 npm install --omit=dev --no-audit --no-fund sqlite3@5.1.7
node -e "require('express'); require('sqlite3'); console.log('OK')"
rc-service alfee restart
tail -n 100 /var/log/alfee.err
```

### Debian/Ubuntu (systemd) - alternatywa

Jesli kiedys przeniesiesz VPS na Debian/Ubuntu:

```bash
chmod +x deploy/lowram/install.sh deploy/lowram/update.sh
./deploy/lowram/install.sh
```

Aktualizacja:

```bash
./deploy/lowram/update.sh
```

### Opcjonalnie: swap dla bardzo malych maszyn (np. 512 MB RAM)

Na Alpine:

```bash
dd if=/dev/zero of=/swapfile bs=1M count=1024
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Alternatywa: Docker/Compose

Pliki `Dockerfile` i `docker-compose.yml` nadal sa w repo, ale na bardzo malym VPS wariant bez Dockera jest lzejszy.
