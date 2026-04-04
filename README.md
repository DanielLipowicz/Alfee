# Alfee - zadania z logowaniem lokalnym/Google i tenantami

Aplikacja webowa z trzema rolami:

- `admin`:
  - tworzy organizacje,
  - przypisuje kierownikow i pracownikow do organizacji,
  - zarzadza czlonkostwami w tenantach.
- `manager`:
  - przelacza aktywna organizacje,
  - tworzy, kopiuje, edytuje i usuwa zadania tylko w aktywnej organizacji,
  - przydziela zadania pracownikom nalezacym do tej samej organizacji,
  - sledzi postep i zdjecia dowodowe.
- `employee`:
  - przeglada swoje przydzielone zadania (takze z wielu organizacji),
  - odznacza czynnosci jako ukonczone,
  - dodaje zdjecia jako dowody wykonania.

## Autoryzacja

- Rejestracja lokalna: `nazwa uzytkownika + email` (konto domyslnie aktywne).
- Logowanie lokalne: `nazwa uzytkownika + email`.
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

- `ADMIN_EMAILS`: konta z tej listy dostaja role `admin`.
- `MANAGER_EMAILS`: konta z tej listy dostaja role `manager`.
- Pozostali uzytkownicy dostaja role `employee`.
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

## License and Copyright

This software is provided "AS IS" and you use it at your own risk.
All copyrights and rights to the software belong to:
**Check-IT Daniel Lipowicz**.

The full license terms are available in `LICENSE.md`.

## Deploy "as code" na VPS Linux (ultra low RAM, bez Dockera)

To jest rekomendowana sciezka dla bardzo malych VPS:
- bez `docker` i bez `compose`,
- czysty `node` + `systemd`,
- limit RAM dla procesu Node.

Docelowy adres:
- `http://frog01.mikr.us:20120/`
- port `20120` jest wymuszony w usludze systemd.

### 1) Sklonuj repo i uruchom instalator

```bash
git clone <URL_TWOJEGO_REPO> alfee
cd alfee
chmod +x deploy/lowram/install.sh deploy/lowram/update.sh
./deploy/lowram/install.sh
```

Instalator wykona:
- instalacje `node`/`npm`,
- `npm ci --omit=dev`,
- utworzenie `data/` i `uploads/`,
- instalacje i start uslugi `alfee.service` z limitem pamieci.

### 2) Ustaw `.env`

```bash
nano .env
```

Minimum:

```env
PORT=20120
SESSION_SECRET=tu-bardzo-mocny-losowy-sekret
GOOGLE_CALLBACK_URL=http://frog01.mikr.us:20120/auth/google/callback
```

Jesli nie uzywasz Google OAuth, pozostaw `GOOGLE_CLIENT_ID` i `GOOGLE_CLIENT_SECRET` puste.

### 3) Restart po zmianie `.env`

```bash
sudo systemctl restart alfee
```

### 4) Sprawdz czy dziala

```bash
sudo systemctl status alfee --no-pager
journalctl -u alfee -n 100 --no-pager
```

Jesli masz `ufw`:

```bash
sudo ufw allow 20120/tcp
```

Aplikacja powinna dzialac pod:
- `http://frog01.mikr.us:20120/`

### 5) Aktualizacja aplikacji (as code)

```bash
./deploy/lowram/update.sh
```

### 6) Opcjonalnie: swap dla bardzo malych maszyn (np. 512 MB RAM)

```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 7) Alternatywa: Docker/Compose

Pliki `Dockerfile` i `docker-compose.yml` nadal sa w repo, ale na bardzo malym VPS wariant `systemd` jest zwykle lzejszy i stabilniejszy.
