# Testy wydajnosciowe (Gatling + TypeScript)

Ten katalog zawiera starter do testow wydajnosciowych aplikacji Alfee:
- podzial ruchu po rolach: `2% admin`, `20% manager`, `78% employee`
- test oparty o **closed model** (uzytkownicy jednoczesni)
- symulacja: `roleCapacitySimulation`

## Struktura

- `src/roleCapacitySimulation.gatling.ts` - glowna symulacja
- `resources/admins.csv` - konta administratorow
- `resources/managers.csv` - konta kierownikow
- `resources/employees.csv` - konta pracownikow

## Wymagania

- Node.js LTS (20+)
- npm

## Szybki start

1. Przejdz do katalogu:

   ```powershell
   cd tests/performance/gatling-ts
   ```

2. Zainstaluj zaleznosci:

   ```powershell
   npm install
   ```

3. Uzupelnij pliki CSV realnymi kontami testowymi.

4. Uruchom symulacje:

   ```powershell
   npm run run -- --baseUrl=http://localhost:3000 --totalUsers=100 --rampSeconds=60 --steadySeconds=180
   ```

Raport HTML pojawi sie po zakonczonym tescie w katalogu `target/gatling/...`.

## Parametry symulacji

- `baseUrl` (domyslnie `http://localhost:3000`)
- `totalUsers` (domyslnie `100`) - laczna liczba jednoczesnych uzytkownikow
- `rampSeconds` (domyslnie `60`) - czas narastania do docelowej liczby userow
- `steadySeconds` (domyslnie `180`) - czas utrzymania stalego obciazenia
- `maxResponseTimeMs` (domyslnie `5000`) - limit dla `global.responseTime.max`
- `minSuccessfulRequestsPercent` (domyslnie `95`) - minimalny procent poprawnych requestow

## Jak szukac limitu aplikacji

Stopniowo zwiekszaj `totalUsers` i obserwuj:
- procent bledow
- czasy odpowiedzi
- wykorzystanie CPU/RAM bazy i aplikacji

Przykladowa sekwencja:

```powershell
npm run run -- --baseUrl=http://localhost:3000 --totalUsers=50  --rampSeconds=60 --steadySeconds=180
npm run run -- --baseUrl=http://localhost:3000 --totalUsers=100 --rampSeconds=60 --steadySeconds=180
npm run run -- --baseUrl=http://localhost:3000 --totalUsers=150 --rampSeconds=60 --steadySeconds=180
npm run run -- --baseUrl=http://localhost:3000 --totalUsers=200 --rampSeconds=60 --steadySeconds=180
```

Punkt, w ktorym zaczynaja rosnac bledy lub przekraczane sa progi SLA, to praktyczny limit dla danej konfiguracji.

