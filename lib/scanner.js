import * as cheerio from "cheerio";

// ─────────────────────────────────────────────────────────────────────────
// KONFIGURACJA — wszystko wcześniej ustawiane w panelu (localStorage) teraz
// czytamy ze zmiennych środowiskowych Vercela (Project Settings → Environment Variables)
// ─────────────────────────────────────────────────────────────────────────
const DEFAULT_FILTER_KEYWORDS =
  "Rennrad, Gravel, Trekkingrad, Hollandrad, Cityrad, Stadtrad, Kinderfahrrad, Laufrad, Klapprad, Liegerad, Dreirad, Rollator, Ersatzteile, Einzelteile, nur Rahmen, Rahmen only, Rahmenset, Bastlerrad, Schrott, gesucht, Kinder, Jugend, 12 Zoll, 16 Zoll, 20 Zoll, 24 Zoll, Damenrad, Herrenrad, Tourenrad, Reiserad, Crossrad, Fitnessbike, Singlespeed, Fixie, BMX Freestyle, Faltrad, Lastenrad, Cargobike, Seniorenrad, Elektroroller, E-Scooter, Escooter, Motorroller, Tretroller, Kickscooter, Balance Bike, Laufrädchen, Fahrradanhänger, Kinderanhänger, Kinderwagen, Fahrradträger, Rollstuhl, Vermietung, Verleih, Miete, Tausch gegen, Deko, Bastelobjekt, Spielzeugrad, Puky, Kettcar, Dreiradwagen";

const BIKE_MODELS = [
  {
    id: "cat_mountainbike",
    label: "🏔️ Mountain Bike",
    categoryUrl:
      "https://www.kleinanzeigen.de/s-fahrraeder/preis:200:2000/c217+fahrraeder.type_s:mountainbike",
  },
];

const GROQ_CLASSIFIER_MODEL = "llama-3.1-8b-instant";

function getConfig() {
  return {
    provider: process.env.PROVIDER || "groq",
    apiKey: process.env.MAIN_API_KEY || "",
    model: process.env.MAIN_MODEL || "llama-3.3-70b-versatile",
    groqClassifierKey: process.env.GROQ_CLASSIFIER_KEY || "",
    minProfit: Number(process.env.MIN_PROFIT || 20),
    maxGeminiPerCycle: Number(process.env.MAX_PER_CYCLE || 25),
    minUncertainPrice: Number(process.env.MIN_UNCERTAIN_PRICE || 500),
    discordWebhook: process.env.DISCORD_WEBHOOK_URL || "",
    discordThread: process.env.DISCORD_THREAD_ID || "",
    uncertainWebhook: process.env.DISCORD_UNCERTAIN_WEBHOOK_URL || "",
    filterKeywords: process.env.FILTER_KEYWORDS || DEFAULT_FILTER_KEYWORDS,
    priceKnowledge: (process.env.PRICE_KNOWLEDGE || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    // Bezpiecznik czasowy — zostaw margines przed limitem maxDuration funkcji.
    maxRunMs: Number(process.env.MAX_RUN_MS || 50_000),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Gemini/Groq — wywołanie AI (dawniej api/gemini.js proxy, teraz wołane bezpośrednio) ──
function buildThinkingConfig(m) {
  const name = (m || "").toLowerCase();
  const isGen3 = /gemini-3|flash-latest|pro-latest/.test(name);
  if (isGen3) {
    const isPro = /pro/.test(name);
    return { thinkingLevel: isPro ? "low" : "minimal" };
  }
  return { thinkingBudget: 0 };
}

async function callAI({ provider, model, apiKey, messages, generationConfig }) {
  if (provider === "groq") {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        temperature: generationConfig?.temperature ?? 0.7,
        max_tokens: generationConfig?.maxOutputTokens ?? 2048,
      }),
    });
    return resp.json();
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: messages,
      generationConfig: {
        temperature: generationConfig?.temperature ?? 0.7,
        maxOutputTokens: generationConfig?.maxOutputTokens ?? 2048,
        thinkingConfig: buildThinkingConfig(model),
        ...(generationConfig?.responseMimeType
          ? { responseMimeType: generationConfig.responseMimeType }
          : {}),
      },
    }),
  });
  return resp.json();
}

// ── Scraping Kleinanzeigen ──────────────────────────────────────────────
async function scrapeKleinanzeigen(bike) {
  const resp = await fetch(bike.categoryUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "de-DE,de;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!resp.ok) throw new Error(`Scrape HTTP ${resp.status}`);
  return resp.text();
}

function parseListings(html, bikeLabel) {
  const $ = cheerio.load(html);
  const items = [];
  const bodyText = $("body").text().toLowerCase();
  if (bodyText.includes("captcha") || bodyText.includes("robot") || bodyText.includes("blocked")) {
    throw new Error("Kleinanzeigen wykrył bota — captcha!");
  }

  $("article.aditem, li.aditem, [data-adid], .ad-listitem").each((_, el) => {
    const article = $(el);
    const linkEl = article.find("a[href*='/s-anzeige/'], a[href*='/anzeige/']").first();
    if (!linkEl.length) return;
    const hrefRaw = linkEl.attr("href");
    const href = hrefRaw.startsWith("http") ? hrefRaw : "https://www.kleinanzeigen.de" + hrefRaw;
    const idMatch = href.match(/-(\d{7,})/);
    const listingId = idMatch ? idMatch[1] : href;

    const titleEl = article.find("h2, h3, .ellipsis, .aditem-main--middle--headline, [class*=headline], [class*=title]").first();
    const title = (titleEl.text() || linkEl.text() || "").trim();
    if (!title) return;

    const priceEl = article.find("[class*=price], .aditem-main--middle--price-shipping--price").first();
    const priceText = (priceEl.text() || "").trim();
    const priceMatch = priceText.match(/([\d.]+),([\d]+)|(\d[\d.]*)/);
    let price = null;
    if (priceMatch) {
      const raw = priceMatch[0].replace(/\./g, "").replace(",", ".");
      price = parseFloat(raw);
      if (isNaN(price)) price = null;
    }

    const descEl = article.find("[class*=description], .aditem-main--middle--description").first();
    const locEl = article.find("[class*=locality], [class*=location], .aditem-main--top--left").first();

    items.push({
      listingId,
      title,
      price,
      href,
      desc: (descEl.text() || "").trim(),
      location: (locEl.text() || "").trim(),
      bike: bikeLabel,
    });
  });

  const uniqueMap = new Map();
  items.forEach((l) => { if (!uniqueMap.has(l.listingId)) uniqueMap.set(l.listingId, l); });
  return [...uniqueMap.values()];
}

// ── Filtr słów kluczowych ───────────────────────────────────────────────
function matchesFilterKeyword(listing, filterKeywords) {
  const haystack = `${listing.title} ${listing.desc}`.toLowerCase();
  const keywords = filterKeywords.split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const kw of keywords) {
    if (kw && haystack.includes(kw)) return kw;
  }
  return null;
}

// ── Etap 1: Groq jako klasyfikator typu ─────────────────────────────────
async function classifyWithGroq(listing, cfg, log) {
  if (!cfg.groqClassifierKey) return "niepewne";

  const prompt = `Klasyfikator ogłoszeń rowerowych. Na podstawie tytułu i opisu określ TYLKO typ roweru.

Typy:
- full — PEŁNE zawieszenie (amortyzator z tyłu + widelec z przodu): enduro/trail/all-mountain/downhill.
- dirt — dirt jump/slopestyle/pumptrack, sztywny hardtail do skoków.
- elektryk_gorski — elektryczny rower górski/e-MTB (napęd + charakter trail/enduro). NIE miejski e-bike.
- inny — reszta: szosówka, gravel, trekking, miejski, dziecięcy, hardtail XC bez cech dirtowych, części, miejski e-bike.

ZASADA: samo słowo "Mountainbike"/"MTB" w tytule BEZ dowodu na pełne zawieszenie = zwykle TANI HARDTAIL, czyli "inny", NIE "full"! Klasyfikuj jako "full" TYLKO gdy jest konkretny dowód: "vollgefedert"/"Fully"/"full suspension", wzmianka o amortyzatorze/zawieszeniu z tyłu ("Dämpfer", "Federung hinten", "Hinterbau"), lub znany model full: Canyon Torque/Spectral/Strive/Neuron/Nerve, Trek Fuel/Slash/Remedy, Specialized Stumpjumper/Enduro/Camber, Cube Stereo/AMS, Santa Cruz, YT, Commencal, Radon Swoop/Slide, Ghost Riot/SL AMR, Focus Jam/Sam/Thron.

ZNANE HARDTAILE (= "inny", nie "full"): Trek Marlin/Roscoe/X-Caliber, Cube Aim/Access/Acid/Analog/Attention/Reaction, BULLS Sharptail/Copperhead/Wildtail/Six50, Rockrider/Rockride (Decathlon, wszystkie ST-serie), Specialized Rockhopper/Pitch/Chisel/Hardrock, Scott Aspect/Scale, Merida Big Nine/Seven/Trail, Ghost Kato/Lanao, Giant Talon/ATX, KTM Chicago/Ultra, Focus Whistler/Raven.

E-BIKE: sygnały napędu ("E-Bike","Akku","Motor",Bosch/Shimano Steps/Brose/Yamaha, przebieg w km, "E1.5"/"E-8"). Z charakterem górskim (zawieszenie/MTB/teren) → elektryk_gorski. Z charakterem miejskim/touring (koszyk, błotniki, "City"/"Trekking") → inny.

Brak wystarczających informacji → odpowiedz: niepewne

Tytuł: ${listing.title}
Opis: ${listing.desc}

Odpowiedz WYŁĄCZNIE jednym słowem (full/dirt/elektryk_gorski/inny/niepewne), bez innego tekstu.`;

  try {
    const data = await callAI({
      provider: "groq",
      model: GROQ_CLASSIFIER_MODEL,
      apiKey: cfg.groqClassifierKey,
      messages: [{ role: "user", content: prompt }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 20 },
    });
    if (data?.error) {
      log(`⚠️ Groq klasyfikator: ${data.error?.message || "błąd"} — przepuszczam jako niepewne`, "error");
      return "niepewne";
    }
    const raw = (data?.choices?.[0]?.message?.content || "").toLowerCase().trim();
    if (raw.includes("elektryk")) return "elektryk_gorski";
    if (raw.includes("dirt")) return "dirt";
    if (raw.includes("full")) return "full";
    if (raw.includes("inny")) return "inny";
    return "niepewne";
  } catch (e) {
    log(`⚠️ Groq klasyfikator: ${e.message} — przepuszczam jako niepewne`, "error");
    return "niepewne";
  }
}

// ── Etap 2: analiza opłacalności ────────────────────────────────────────
async function analyzeWithGemini(listing, groqType, cfg) {
  const knowledgeSection =
    cfg.priceKnowledge.length > 0
      ? `=== TWOJA BAZA WIEDZY O CENACH (REALNE TRANSAKCJE I NOTATKI — NAJWAŻNIEJSZE ŹRÓDŁO) ===\n${cfg.priceKnowledge
          .map((e, i) => `${i + 1}. ${e}`)
          .join("\n")}\n\nTa baza pochodzi z realnych sprzedaży — traktuj ją jako priorytetowe źródło prawdy o cenach.\n\n`
      : "";

  const typeIsTrusted = ["full", "dirt", "elektryk_gorski"].includes(groqType);
  const typeSection = typeIsTrusted
    ? `=== TYP ROWERU — JUŻ USTALONY, ZAUFAJ TEMU ===\nTo ogłoszenie zostało już sklasyfikowane jako: "${groqType}". NIE klasyfikuj od nowa — w polu "typ_roweru" wpisz dokładnie "${groqType}".\n\n`
    : `=== KROK 1 — ROZPOZNAJ TYP ROWERU ===\nSam określ typ: "dirt" (dirt jump/hardtail do skoków), "full" (pełne zawieszenie: enduro/trail/downhill), "elektryk_gorski" (e-MTB górski), "inny" (wszystko inne). Jeśli typ = "inny" → decyzja: "nie".\n\n`;

  const prompt = `Jesteś ekspertem od rowerów dirtowych, MTB full-suspension i e-MTB górskich. Kupujesz rowery w Niemczech i resellujesz je w Polsce z zyskiem.

${knowledgeSection}=== CENNIK REFERENCYJNY ===
• Canyon Stitched 360 Pro (2021-2024): cena zakupu max 500-600€. Wersja z upgradami do 700€.
• Rose The Bruce 2: max zakup 500-550€ (sprzedaż ~880€ PL).
• Trek Ticket DJ z Pike DJ/Bomber DJ: do 900€ (sprzedaż 1400€ PL).
• Canyon Torque AL 5 (2018): zakup do 700€, sprzedaż ~1160€ PL.
• Canyon Spectral AL 6: zakup do 1000€, sprzedaż ~1510€ PL.
• Dartmoor Two6player, Specialized P.3, Radon Slush: wyceniaj analogicznie do Stitched.

${typeSection}=== OCENA OPŁACALNOŚCI ===
• Jeśli typ = "inny" → ZAWSZE decyzja: "nie".
• Oszacuj realną cenę sprzedaży w Polsce, oblicz zysk = sprzedaż - zakup.
• decyzja: "tak" TYLKO jeśli zysk >= ${cfg.minProfit}% ceny zakupu i jesteś wystarczająco pewny.
• decyzja: "niepewne" gdy brakuje kluczowych informacji (brak ceny, zdawkowy opis, niejasny model).
• decyzja: "nie" gdy masz dane by stwierdzić że zysk jest za mały.
• Jeśli cena nie jest podana → decyzja: "niepewne".

=== OGŁOSZENIE DO OCENY ===
Tytuł: ${listing.title}
Cena z ogłoszenia: ${listing.price != null ? listing.price + "€" : "BRAK CENY"}
Lokalizacja: ${listing.location}
Opis: ${listing.desc}
Model/kategoria wyszukiwania: ${listing.bike}

Odpowiedz WYŁĄCZNIE w JSON (zero markdown, zero komentarzy):
{
  "typ_roweru": "full" | "dirt" | "elektryk_gorski" | "inny",
  "decyzja": "tak" | "nie" | "niepewne",
  "cena_zakupu_eur": liczba lub null,
  "szacowana_sprzedaz_eur": liczba lub null,
  "przewidywany_zysk": liczba w EUR lub 0
}`;

  try {
    const messages =
      cfg.provider === "groq"
        ? [{ role: "user", content: prompt }]
        : [{ role: "user", parts: [{ text: prompt }] }];
    const data = await callAI({
      provider: cfg.provider,
      model: cfg.model,
      apiKey: cfg.apiKey,
      messages,
      generationConfig:
        cfg.provider === "groq"
          ? { temperature: 0.3, maxOutputTokens: 200 }
          : { temperature: 0.3, maxOutputTokens: 200, responseMimeType: "application/json" },
    });
    if (data?.error) throw new Error(data.error?.message || JSON.stringify(data.error));

    const raw =
      cfg.provider === "groq"
        ? data?.choices?.[0]?.message?.content || ""
        : data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!raw) throw new Error("pusta odpowiedź AI");

    let clean = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (jsonMatch) clean = jsonMatch[0];
    const parsed = JSON.parse(clean);

    const typ = typeIsTrusted
      ? groqType
      : ["full", "dirt", "elektryk_gorski"].includes(parsed.typ_roweru)
      ? parsed.typ_roweru
      : "inny";
    parsed.typ_roweru = typ;
    parsed.decyzja = ["tak", "nie", "niepewne"].includes(parsed.decyzja) ? parsed.decyzja : "nie";
    if (typ === "inny") parsed.decyzja = "nie";
    parsed.oplaca_sie = parsed.decyzja === "tak";

    const { cena_zakupu_eur: cena, szacowana_sprzedaz_eur: sprzedaz, przewidywany_zysk: zysk } = parsed;
    if (parsed.decyzja === "tak") {
      parsed.krotki_opis = `Zakup ${cena}€ → szacowana sprzedaż PL ${sprzedaz}€ → zysk ~${zysk}€.`;
    } else if (parsed.decyzja === "niepewne") {
      parsed.krotki_opis =
        cena != null
          ? `Zakup ${cena}€ — za mało danych żeby ocenić. Wymaga ręcznego sprawdzenia.`
          : `Brak ceny w ogłoszeniu — wymaga ręcznego sprawdzenia.`;
    } else if (typ === "inny") {
      parsed.krotki_opis = `Typ roweru: inny — odrzucone automatycznie.`;
    } else {
      parsed.krotki_opis = `Zakup ${cena ?? "?"}€ — zysk za mały lub transakcja się nie opłaca.`;
    }
    return parsed;
  } catch (e) {
    return null;
  }
}

// ── Discord ──────────────────────────────────────────────────────────────
const TYPE_LABELS = {
  full: "🟢 Full",
  dirt: "🟠 Dirt",
  elektryk_gorski: "⚡ Elektryk górski",
  inny: "⚫ Inny",
};

async function sendToDiscord(listing, analysis, cfg) {
  const embed = {
    title: `🚲 OKAZJA: ${listing.title}`,
    url: listing.href,
    color: 0x22c55e,
    fields: [
      { name: "🚴 Typ roweru", value: `**${TYPE_LABELS[analysis.typ_roweru] || analysis.typ_roweru}**`, inline: true },
      { name: "💰 Cena z ogłoszenia", value: listing.price != null ? `**${listing.price}€**` : "brak", inline: true },
      { name: "✅ Opłaca się", value: analysis.oplaca_sie ? "**TAK**" : "**NIE**", inline: true },
      { name: "🤑 Przewidywany zysk", value: `**~${analysis.przewidywany_zysk}€**`, inline: true },
      { name: "📍 Lokalizacja", value: listing.location || "–", inline: true },
      { name: "🔎 Wyszukiwanie", value: listing.bike, inline: true },
      { name: "🔗 Link do ogłoszenia", value: listing.href },
      { name: "📝 Krótki opis", value: analysis.krotki_opis },
    ],
    footer: { text: `DirtDealFinder • ${new Date().toLocaleString("pl-PL")}` },
  };
  const url = cfg.discordWebhook + (cfg.discordThread ? `?thread_id=${cfg.discordThread}` : "");
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });
  return resp.ok;
}

async function sendUncertainBatch(uncertainBatch, cycleN, cfg) {
  if (!cfg.uncertainWebhook || uncertainBatch.length === 0) return;
  const lines = uncertainBatch
    .map((u) => `🔸 ${u.listing.title}${u.listing.price != null ? ` (${u.listing.price}€)` : ""} — ${u.reason}\n${u.listing.href}`)
    .join("\n\n");
  const content = `❓ **Niepewne rowery — cykl #${cycleN}** (${uncertainBatch.length})\n\n${lines}`.slice(0, 1900);
  await fetch(cfg.uncertainWebhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// GŁÓWNY CYKL — wywoływany raz na uruchomienie crona
// ─────────────────────────────────────────────────────────────────────────
export async function runScanCycle(redis) {
  const cfg = getConfig();
  const startedAt = Date.now();
  const timeLeft = () => cfg.maxRunMs - (Date.now() - startedAt);

  const logs = [];
  const results = [];
  const log = (msg, type = "info") => {
    logs.push({ time: new Date().toLocaleTimeString("pl-PL"), msg, type });
  };
  const pushResult = (listing, analysis, status) => {
    results.push({ id: `${Date.now()}-${Math.random()}`, listing, analysis, status, timestamp: new Date().toLocaleTimeString("pl-PL") });
  };

  if (!cfg.apiKey) throw new Error("Brak MAIN_API_KEY w zmiennych środowiskowych");
  if (!cfg.discordWebhook) throw new Error("Brak DISCORD_WEBHOOK_URL w zmiennych środowiskowych");

  const cycleN = await redis.incr("ddf:cycle_num");
  const seeded = await redis.get("ddf:seeded");

  log(`🔄 Cykl #${cycleN} — start`, "success");

  const stats = { scanned: 0, deals: 0, sent: 0 };
  const uncertainBatch = [];
  let timedOut = false;

  for (const bike of BIKE_MODELS) {
    if (timeLeft() < 5000) { timedOut = true; break; }

    let listings = [];
    try {
      const html = await scrapeKleinanzeigen(bike);
      listings = parseListings(html, bike.label);
      log(`📋 ${bike.label}: znaleziono ${listings.length} ogłoszeń`, "info");
    } catch (e) {
      log(`⚠️ ${bike.label}: błąd scraping — ${e.message}`, "error");
      continue;
    }

    // Sprawdź które ID są nowe (bez oznaczania jako widziane — to robimy dopiero PO przetworzeniu,
    // żeby ogłoszenia przerwane limitem czasu wróciły w kolejnym uruchomieniu)
    const freshChecks = await Promise.all(
      listings.map(async (l) => ({ l, isSeen: (await redis.sismember("ddf:seen", l.listingId)) === 1 }))
    );
    const fresh = freshChecks.filter((f) => !f.isSeen).map((f) => f.l);

    if (!seeded) {
      // Pierwsze uruchomienie w historii — tylko zapamiętaj co już istnieje, nie analizuj (jak "cykl #1")
      if (fresh.length > 0) await redis.sadd("ddf:seen", ...fresh.map((l) => l.listingId));
      log(`📌 ${bike.label}: pierwsze uruchomienie — zapamiętano ${fresh.length} istniejących ogłoszeń, bez analizy`, "info");
      continue;
    }

    if (fresh.length === 0) {
      log(`✔ ${bike.label}: brak nowych`, "info");
    } else {
      log(`🆕 ${bike.label}: ${fresh.length} nowych ogłoszeń`, "success");
      stats.scanned += fresh.length;
    }

    const geminiCandidates = [];

    for (const listing of fresh) {
      if (timeLeft() < 8000) { timedOut = true; break; }

      const filterHit = matchesFilterKeyword(listing, cfg.filterKeywords);
      if (filterHit) {
        await redis.sadd("ddf:seen", listing.listingId);
        log(`🚫 Filtr: odrzucono (słowo: "${filterHit}") — ${listing.title}`, "info");
        pushResult(listing, { typ_roweru: "inny", decyzja: "nie", krotki_opis: `Odrzucone filtrem (${filterHit})` }, "skip");
        continue;
      }

      const typ = await classifyWithGroq(listing, cfg, log);
      if (cfg.groqClassifierKey) await sleep(1200); // margines pod limit RPM Groqa

      if (typ === "inny") {
        await redis.sadd("ddf:seen", listing.listingId);
        log(`🚫 Groq: typ "inny" — odrzucono — ${listing.title}`, "info");
        pushResult(listing, { typ_roweru: "inny", decyzja: "nie", krotki_opis: "Odrzucone przez Groq — nie full/dirt/elektryk" }, "skip");
        continue;
      }

      if (listing.price == null) {
        await redis.sadd("ddf:seen", listing.listingId);
        uncertainBatch.push({ listing, reason: "brak ceny w ogłoszeniu" });
        pushResult(listing, { typ_roweru: "?", decyzja: "niepewne", krotki_opis: "Brak ceny" }, "skip");
        continue;
      }

      if (typ === "niepewne" && listing.price < cfg.minUncertainPrice) {
        await redis.sadd("ddf:seen", listing.listingId);
        log(`🚫 Niepewny typ + cena ${listing.price}€ < ${cfg.minUncertainPrice}€ — odrzucono — ${listing.title}`, "info");
        pushResult(listing, { typ_roweru: "?", decyzja: "nie", krotki_opis: `Niepewny typ, cena poniżej progu ${cfg.minUncertainPrice}€` }, "skip");
        continue;
      }

      geminiCandidates.push({ listing, groqType: typ });
    }
    if (timedOut) break;

    const sorted = geminiCandidates.sort((a, b) => (b.groqType !== "niepewne" ? 1 : 0) - (a.groqType !== "niepewne" ? 1 : 0));

    let geminiCalls = 0;
    for (const { listing, groqType } of sorted) {
      if (timeLeft() < 6000) { timedOut = true; break; }
      if (geminiCalls >= cfg.maxGeminiPerCycle) {
        // Limit cyklu — NIE oznaczaj jako widziane, spróbuj ponownie następnym razem
        log(`⏭ Limit ${cfg.maxGeminiPerCycle} analiz/cykl osiągnięty: ${listing.title}`, "info");
        continue;
      }
      geminiCalls++;
      const analysis = await analyzeWithGemini(listing, groqType, cfg);
      await redis.sadd("ddf:seen", listing.listingId);

      let status = "skip";
      if (!analysis) {
        status = "error";
        log(`⚠️ Błąd analizy AI — ${listing.title}`, "error");
      } else if (analysis.decyzja === "tak") {
        log(`✅ OKAZJA! [${analysis.typ_roweru}] ${listing.title} | zysk: ~${analysis.przewidywany_zysk}€`, "success");
        stats.deals++;
        const sent = await sendToDiscord(listing, analysis, cfg);
        status = sent ? "sent" : "deal";
        if (sent) { stats.sent++; log(`📨 Wysłano na Discord: ${listing.href}`, "success"); }
      } else if (analysis.decyzja === "niepewne") {
        uncertainBatch.push({ listing, reason: analysis.krotki_opis });
      } else {
        log(`⏭ NIE opłaca się — ${listing.title}`, "info");
      }
      pushResult(listing, analysis || { typ_roweru: groqType, decyzja: "błąd", krotki_opis: "Błąd analizy AI" }, status);

      await sleep(1500);
    }
  }

  if (!seeded) {
    await redis.set("ddf:seeded", "true");
  }

  await sendUncertainBatch(uncertainBatch, cycleN, cfg);
  if (uncertainBatch.length > 0) log(`❓ ${uncertainBatch.length} niepewnych rowerów${cfg.uncertainWebhook ? " — wysłano na Discord" : ""}`, "info");

  if (timedOut) log(`⏱ Cykl przerwany limitem czasu — pozostałe ogłoszenia zostaną sprawdzone w kolejnym uruchomieniu`, "error");
  log(`✔ Cykl #${cycleN} zakończony`, "success");

  // Zapis logów i wyników do Redis (dla panelu podglądu)
  if (logs.length > 0) {
    await redis.lpush("ddf:logs", ...logs.map((l) => JSON.stringify(l)).reverse());
    await redis.ltrim("ddf:logs", 0, 499);
  }
  if (results.length > 0) {
    await redis.lpush("ddf:results", ...results.map((r) => JSON.stringify(r)).reverse());
    await redis.ltrim("ddf:results", 0, 199);
  }
  const lastRun = { cycleN, timestamp: new Date().toISOString(), stats, timedOut };
  await redis.set("ddf:last_run", JSON.stringify(lastRun));

  return lastRun;
}

