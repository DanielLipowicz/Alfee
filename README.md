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

## Deploy "as code" na VPS Linux (maly RAM)

Ponizej masz deployment oparty o `Dockerfile` + `docker-compose.yml` (to jest warstwa "as code").

Wymagany adres aplikacji:
- `http://frog01.mikr.us:20120/`
- port `20120` jest na stale mapowany w `docker-compose.yml`.

### 1) Przygotuj VPS (Docker + Compose)

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
```

Wyloguj i zaloguj sie ponownie, zeby grupa `docker` zaczela dzialac.

Opcjonalnie (bardzo maly RAM, np. 512 MB): dodaj swap 1G:

```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 2) Wgraj projekt i ustaw .env

```bash
git clone <URL_TWOJEGO_REPO> alfee
cd alfee
cp .env.example .env
```

Edytuj `.env`:

```env
PORT=20120
SESSION_SECRET=tu-bardzo-mocny-losowy-sekret
GOOGLE_CALLBACK_URL=http://frog01.mikr.us:20120/auth/google/callback
```

Jesli nie uzywasz Google OAuth, mozesz zostawic `GOOGLE_CLIENT_ID` i `GOOGLE_CLIENT_SECRET` puste.

### 3) Start aplikacji

```bash
mkdir -p data uploads
docker compose up -d --build
```

Sprawdzenie:

```bash
docker compose ps
docker compose logs -f --tail=100
```

Aplikacja powinna byc dostepna pod:
- `http://frog01.mikr.us:20120/`

### 4) Firewall / port na VPS

Jesli masz `ufw`, odblokuj port:

```bash
sudo ufw allow 20120/tcp
```

### 5) Aktualizacja aplikacji

```bash
git pull
docker compose up -d --build
```

### 6) Ustawienia pod niski RAM (juz w kodzie deployu)

W `docker-compose.yml` sa juz ustawione:
- `mem_limit: 256m`
- `NODE_OPTIONS=--max-old-space-size=128`

To ogranicza zuzycie pamieci przez Node.js i pomaga na malym VPS.
