# DirtDealFinder — wersja bez otwartej strony (Vercel Cron)

Ta wersja skanuje Kleinanzeigen **automatycznie, raz dziennie, bez potrzeby trzymania otwartej karty przeglądarki**. Cała logika (scraping, klasyfikacja Groq, ocena Gemini, wysyłka na Discord) działa teraz w funkcji serwerowej wywoływanej przez Vercel Cron. `index.html` to już tylko panel podglądu wyników.

## Co się zmieniło względem poprzedniej wersji

- **Logika skanowania** przeniesiona do `lib/scanner.js` — działa po stronie serwera.
- **`api/cron.js`** — endpoint wywoływany automatycznie przez Vercel raz dziennie (domyślnie 6:00 UTC = 7:00/8:00 czasu polskiego, zależnie od czasu letniego).
- **`api/status.js`** — zwraca dane dla panelu (statystyki, logi, wyniki).
- **`api/trigger.js`** — pozwala odpalić skan ręcznie z panelu (chronione hasłem).
- **Ustawienia** (klucze API, webhook, próg zysku, filtr słów) — wcześniej w panelu, teraz jako **zmienne środowiskowe** na Vercelu.
- **"Widziane ogłoszenia"** — wcześniej w `localStorage`, teraz w **Upstash Redis** (baza w chmurze, dostępna dla funkcji serwerowej).
- Funkcja chatu AI i edytowalna baza cenowa z poprzedniej wersji zostały usunięte (wymagały interaktywnego UI) — jeśli chcesz, mogę je odtworzyć jako osobny endpoint.

## Krok po kroku

### 1. Załóż darmowe konto Upstash i bazę Redis
1. Wejdź na [upstash.com](https://upstash.com) → zarejestruj się (można przez GitHub).
2. Utwórz nową bazę **Redis** (Create Database), region najbliższy Twojemu projektowi na Vercelu.
3. Nie musisz nic kopiować ręcznie — w kroku 3 podłączysz to przez integrację Vercela, która sama doda potrzebne zmienne.

### 2. Wrzuć ten projekt na GitHub
Załóż nowe repozytorium i wypchnij do niego wszystkie pliki z tego folderu (strukturę `api/`, `lib/`, `public/`, `package.json`, `vercel.json`).

### 3. Importuj projekt na Vercel
1. [vercel.com/new](https://vercel.com/new) → wybierz repozytorium.
2. Przy imporcie **Storage → Connect Database → Upstash → Redis** — połącz bazę założoną w kroku 1. Vercel sam doda zmienne `UPSTASH_REDIS_REST_URL` i `UPSTASH_REDIS_REST_TOKEN`.
3. W **Environment Variables** dodaj resztę zmiennych z pliku `.env.example` (minimum: `MAIN_API_KEY`, `MAIN_MODEL`, `DISCORD_WEBHOOK_URL`, `MANUAL_TRIGGER_SECRET`).
4. Deploy.

### 4. Sprawdź, czy działa
- Otwórz stronę główną projektu (np. `https://twoj-projekt.vercel.app`) — powinieneś zobaczyć panel podglądu.
- Wpisz hasło z `MANUAL_TRIGGER_SECRET` i kliknij **▶ Uruchom teraz** — pierwszy cykl tylko zapamięta obecne ogłoszenia (jak dawniej "cykl #1"), nic nie wyśle na Discord. Drugie uruchomienie zacznie realnie analizować nowe ogłoszenia.
- Od tej pory Vercel Cron będzie odpalał `api/cron` automatycznie raz dziennie — nic nie musisz robić.

## Ważne ograniczenia planu Hobby (darmowego)

- **Cron może odpalać się maksymalnie raz dziennie.** Jeśli chcesz częściej (np. co 15 minut) — potrzebny jest plan **Pro** (~20$/mies.), a wtedy zmieniamy tylko jedną linijkę w `vercel.json` (`"schedule"`).
- **Limit czasu funkcji ~60s.** Jeśli w ciągu dnia pojawi się bardzo dużo nowych ogłoszeń, skaner może nie zdążyć przeanalizować wszystkich w jednym uruchomieniu — nieprzetworzone ogłoszenia **nie** są tracone, po prostu poczekają do następnego dnia (widać to w panelu jako "przerwano limitem czasu").
- Harmonogram crona (`vercel.json` → `"schedule": "0 6 * * *"`) jest w **UTC**. Chcesz inną godzinę? Podaj mi jaką, przeliczę.

## Zmiana godziny/częstotliwości crona

W `vercel.json`, pole `schedule` to standardowy zapis cron (`minuta godzina dzień miesiąc dzień-tygodnia`), np.:
- `"0 6 * * *"` — codziennie o 6:00 UTC
- `"0 */6 * * *"` — co 6 godzin (wymaga planu Pro)
- `"*/15 * * * *"` — co 15 minut (wymaga planu Pro)

Daj znać jeśli chcesz, żebym coś tu dostosował.
