/**
 * Deterministic menu parsers for products import.
 * Used to ground AI structuring on clean price-list / dual-column / allergen text
 * so later menu/showcase generation has complete, correctly categorized catalogs.
 */

import { isDietOrVariantLabel, offeringRole } from "./catalog-place.js";

function compact(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function productNameKey(value = "") {
  return compact(String(value || ""))
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/\bm\//g, "med ")
    .replace(/[^a-z0-9æøåäöüéèê\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKr(raw = "") {
  let price = compact(raw).replace(/\s+/g, " ");
  if (!price) return "";
  // "125 k" / "125,-" / "KR: 325,-" / "45 kr"
  price = price.replace(/^(kr|KR)\s*[:.]?\s*/i, "");
  price = price.replace(/,-$/g, "");
  if (/^\d+[.,]?\d*\s*k$/i.test(price)) price = `${price.slice(0, -1).trim()} kr`;
  if (/^\d+[.,]?\d*$/.test(price)) price = `${price} kr`;
  if (/^\d+[.,]?\d*\s*kr$/i.test(price)) {
    const num = price.replace(/\s*kr$/i, "").trim();
    price = `${num} kr`;
  }
  return price;
}

function looksLikePriceCell(value = "") {
  const t = compact(value);
  if (!t) return false;
  return /^(kr\s*[:.]?\s*)?\d+[.,]?\d*\s*(kr|k)?$/i.test(t) || /^\d+[.,]?\d*\s*,-$/i.test(t);
}

function isPriceColumnLabel(value = "") {
  return /^(café|cafe|ta\s*med|pris|price)$/i.test(compact(value));
}

/** Strict product name match — never let short needles like "te" hit "Ostehorn". */
function productNamesMatch(a = "", b = "") {
  const ka = productNameKey(a);
  const kb = productNameKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;

  const aliases = [
    [/karbonade.*/g, "karbonade"],
    [/egg\s*(og|\/)?\s*bacon/g, "egg bacon"],
    [/eplekake m(ed)?\s*is/g, "eplekake is"],
    [/pasta\s*-?\s*salat/g, "pasta salat"],
    [/pastasalat/g, "pasta salat"],
    [/mousse\s*-?\s*kaker?/g, "moussekake"],
    [/moussekake/g, "moussekake"],
    [/ostekake/g, "ostekake"],
    [/fish\s*n?\s*chips/g, "fish chips"],
  ];
  const aliasKey = (value) => {
    let out = productNameKey(value)
      .replace(/\bmed\b/g, " ")
      .replace(/\bog\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    for (const [re, rep] of aliases) out = out.replace(re, rep);
    return out.replace(/\s+/g, " ").trim();
  };
  const aa = aliasKey(a);
  const bb = aliasKey(b);
  if (aa && aa === bb) return true;

  const pairStarts = (short, long) => {
    if (!short || short.length < 6) return false;
    if (long === short) return true;
    if (long.startsWith(`${short} `) || long.endsWith(` ${short}`) || long.includes(` ${short} `)) return true;
    if (long.startsWith(short) && long.length - short.length <= 28) return true;
    return false;
  };

  return pairStarts(aa, bb) || pairStarts(bb, aa);
}

function looksLikeContactOrLetterhead(line = "") {
  const t = compact(line);
  if (!t) return true;
  if (/^(tel|telefon|tlf\.?|phone|mobil|e-?post|email|www\.|https?:|org\.?\s*nr|orgnr|besøksadresse|postadresse|adresse|åpningstid)/i.test(t)) {
    return true;
  }
  if (/\b\d{2}[\s.]\d{2}[\s.]\d{2}[\s.]\d{2}\b/.test(t)) return true;
  if (/@[\w.-]+\.[a-z]{2,}/i.test(t) && !/\d+[.,]?\d*\s*(kr|,-)/i.test(t)) return true;
  return false;
}

function looksLikeCategoryHeader(value = "") {
  const t = compact(value).replace(/:$/, "");
  if (!t || looksLikePriceCell(t) || looksLikeContactOrLetterhead(t)) return false;
  if (isDietOrVariantLabel(t)) return false;
  if (isPriceColumnLabel(t) || /^(meny|menu|priser|pris|price|products)$/i.test(t)) return false;
  if (/\d/.test(t) && /kr|,-/i.test(t)) return false;
  if (/:$/.test(compact(value)) && t.length <= 40) return true;
  if (/^[A-ZÆØÅÄÖÜ][A-ZÆØÅÄÖÜ\s/&-]{2,28}$/.test(t) && t.split(/\s+/).length <= 3) return true;
  return /^(drikke|drinks|småretter|starters|smørbrød|salater|salads|dessert|desserts|tapas|tillegg|extras?|koldtbord|kaker|cakes|dagens|brød|bread|forrett|hovedrett|mains?|sides?)/i.test(t);
}

function parsePriceLine(line = "") {
  const text = compact(line);
  if (!text) return null;
  // "Name 40,-" / "Name 40 kr" / "Name KR: 325,-"
  const match = text.match(/^(.*?)(?:\s+KR\s*:\s*|\s+)(\d+[.,]?\d*)\s*(?:,-|kr|k)?$/i);
  if (!match) return null;
  const name = compact(match[1].replace(/,?\s*$/, ""));
  if (!name || looksLikeCategoryHeader(name)) return null;
  return { name, price: normalizeKr(match[2]) };
}

/**
 * Dual-column café/restaurant tables emitted by odt-text:
 *   Name | Café | Ta med |  | Name | Café | Ta med
 */
export function parseCafeDualPriceTableText(text = "") {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tableLines = [];
  let inTable = false;
  for (const line of lines) {
    if (/^===\s*TABLE\b/i.test(line)) {
      inTable = true;
      continue;
    }
    if (/^===\s*OTHER\b/i.test(line)) break;
    if (inTable) tableLines.push(line);
  }
  const sourceLines = tableLines.length ? tableLines : lines.filter((line) => line.includes("|"));
  if (!sourceLines.length) return null;

  let leftCategory = "Meny";
  let rightCategory = "Meny";
  let rightGroupPrefix = "";
  const byCategory = new Map();

  const ensure = (name) => {
    const key = productNameKey(name) || name;
    if (!byCategory.has(key)) byCategory.set(key, { name: compact(name).replace(/:$/, ""), products: [] });
    return byCategory.get(key);
  };

  const pushProduct = (categoryName, name, cafePrice, takeawayPrice, namePrefix = "") => {
    const rawName = compact(name).replace(/,$/, "");
    if (!rawName || looksLikeCategoryHeader(rawName)) return;
    if (looksLikePriceCell(rawName)) return;
    const fullName = namePrefix ? compact(`${namePrefix} ${rawName}`) : rawName;
    const cat = ensure(categoryName);
    const key = productNameKey(fullName);
    const existing = cat.products.find((p) => productNameKey(p.name) === key);
    const row = {
      name: fullName,
      price: normalizeKr(cafePrice),
      comparePrice: normalizeKr(takeawayPrice),
    };
    if (existing) {
      if (row.price) existing.price = row.price;
      if (row.comparePrice) existing.comparePrice = row.comparePrice;
    } else {
      cat.products.push(row);
    }
  };

  for (const line of sourceLines) {
    const cells = line.split("|").map((cell) => compact(cell));
    while (cells.length < 7) cells.push("");
    const [lName, lCafe, lTake, , rName, rCafe, rTake] = cells;

    const leftIsHeader =
      lName &&
      !looksLikePriceCell(lCafe) &&
      !looksLikePriceCell(lTake) &&
      (!lCafe || isPriceColumnLabel(lCafe)) &&
      (!lTake || isPriceColumnLabel(lTake));
    const rightIsHeader =
      rName &&
      !looksLikePriceCell(rCafe) &&
      !looksLikePriceCell(rTake) &&
      (!rCafe || isPriceColumnLabel(rCafe)) &&
      (!rTake || isPriceColumnLabel(rTake));

    // Category / group headers (empty price cells OR Café/Ta med column labels)
    if (leftIsHeader && (looksLikeCategoryHeader(lName) || /dessert/i.test(lName))) {
      leftCategory = compact(lName).replace(/:$/, "");
    }
    if (rightIsHeader) {
      if (looksLikeCategoryHeader(rName)) {
        rightCategory = compact(rName).replace(/:$/, "");
        rightGroupPrefix = "";
      } else if (rName && !looksLikePriceCell(rName)) {
        rightGroupPrefix = compact(rName);
      }
    }

    // Skip pure header rows (no priced items on this line)
    if (
      (isPriceColumnLabel(lCafe) || isPriceColumnLabel(lTake) || isPriceColumnLabel(rCafe) || isPriceColumnLabel(rTake)) &&
      !looksLikePriceCell(lCafe) &&
      !looksLikePriceCell(lTake) &&
      !looksLikePriceCell(rCafe) &&
      !looksLikePriceCell(rTake)
    ) {
      continue;
    }

    if (lName && (looksLikePriceCell(lCafe) || looksLikePriceCell(lTake))) {
      pushProduct(leftCategory, lName, lCafe, lTake);
    }
    if (rName && (looksLikePriceCell(rCafe) || looksLikePriceCell(rTake))) {
      pushProduct(rightCategory, rName, rCafe, rTake, rightGroupPrefix);
    }
  }

  const categories = [...byCategory.values()].filter((category) => category.products.length);
  if (!categories.length) return null;
  return {
    layout: "meny",
    label: "Meny",
    categories,
    confidence: "high",
    source: "cafe-dual-price-table",
  };
}

/** Allergen sheets: "Name: allergens" under optional SECTION: headers. */
export function parseAllergenSheetText(text = "") {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => compact(line))
    .filter(Boolean);
  if (!lines.some((line) => /allergi/i.test(line) || /:\s*.+/i.test(line))) return [];

  let section = "";
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^allergi/i.test(line) && !line.includes(":")) continue;
    if (/^(vi har|gluten-fritt)/i.test(line) && !line.includes(":")) continue;
    const sectionOnly = line.match(/^([A-ZÆØÅÄÖÜ][A-ZÆØÅÄÖÜ\s/]{1,30}):\s*$/);
    if (sectionOnly) {
      const header = compact(sectionOnly[1]);
      if (isDietOrVariantLabel(header)) continue;
      section = header;
      continue;
    }
    const itemMatch = line.match(/^([^:]{2,80}):\s*(.+)$/);
    if (!itemMatch) {
      // Continuation of previous allergens (e.g. "nøtter(...)")
      if (
        rows.length &&
        !line.includes(":") &&
        !/^(vi har|gluten-fritt)/i.test(line) &&
        /nøtt|mandel|hazel|sesam|gluten|melk|egg|soya/i.test(line)
      ) {
        const prev = rows[rows.length - 1];
        prev.allergens = compact(`${prev.allergens}, ${line}`).replace(/,\s*$/, "");
      }
      continue;
    }
    const name = compact(itemMatch[1]);
    let allergens = compact(itemMatch[2]).replace(/,\s*$/, "");
    if (!name || !allergens) continue;
    if (/^(allergi|meny)$/i.test(name)) continue;
    // Skip pure section headers mistaken as items (all caps short)
    if (
      /^[A-ZÆØÅÄÖÜ\s]{3,}$/.test(name) &&
      name.length <= 20 &&
      !allergens.match(/gluten|melk|egg|fisk|torsk|soya|nøtt|sesam|reke|laks/i)
    ) {
      section = name;
      continue;
    }
    // Pull following continuation lines into allergens
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next.includes(":") || /^[A-ZÆØÅÄÖÜ\s]{3,}:/.test(next)) break;
      if (/^(vi har|gluten-fritt)/i.test(next)) break;
      if (!/nøtt|mandel|hazel|sesam|gluten|melk|egg|soya/i.test(next)) break;
      allergens = compact(`${allergens}, ${next}`).replace(/,\s*$/, "");
      i += 1;
    }
    rows.push({
      name,
      allergens,
      sourceCategory: section || guessAllergenCategory(name),
      price: "",
      description: "",
    });
  }
  return rows;
}

function guessAllergenCategory(name = "") {
  const n = productNameKey(name);
  if (/ciabatta|grovis|ostehorn|brød|brod|pålegg|pallegg|foccacia/.test(n)) return "Brød og basis";
  if (/eplekake|iscup|donut|snickers|suksess|ostekake|mousse|konfekt|berliner|kake|terte/.test(n)) {
    return "Kaker og desserter";
  }
  if (/fish|chips|omelett|hamburger|club|ravioli|nachos/.test(n)) return "Småretter";
  if (/reke|laks|karbonade|egg|bacon|smørbrød|smorbrod/.test(n)) return "Smørbrød";
  if (/salat|pasta/.test(n)) return "Salater";
  if (/torsk|skinkestek|kjøttkaker|kjottkaker|pannekaker|dagens/.test(n)) return "Dagens";
  return "Øvrige retter";
}

/** Tapas: bullet list ending with package price, then Tillegg priced lines. */
export function parseTapasMenuText(text = "", { fileName = "" } = {}) {
  const raw = String(text || "");
  // Require a real Tapas title / filename — do not treat "…tapas-menyen…" notes as tapas docs.
  const strictTapas = /tapas/i.test(fileName) || /^tapas\s*$/im.test(raw);
  if (!strictTapas) return null;
  const lines = raw
    .split(/\r?\n/)
    .map((line) => compact(line))
    .filter((line) => line && !/^tapas$/i.test(line) && !/^===\s*/.test(line));

  const included = [];
  const extras = [];
  let packagePrice = "";
  let inExtras = false;

  for (const line of lines) {
    if (/^tillegg/i.test(line)) {
      inExtras = true;
      continue;
    }
    if (inExtras) {
      const priced = parsePriceLine(line);
      if (priced) extras.push(priced);
      continue;
    }
    // "Foccacia, smør KR: 325,-" → include item + package price
    const pkg = line.match(/^(.*?)(?:\s+KR\s*:\s*|\s+)(\d+[.,]?\d*)\s*(?:,-|kr)?$/i);
    if (pkg && /foccacia|focaccia|smør|smor|pakke|tapas/i.test(pkg[1])) {
      const name = compact(pkg[1].replace(/,?\s*$/, ""));
      if (name) included.push(name);
      packagePrice = normalizeKr(pkg[2]);
      continue;
    }
    if (looksLikePriceCell(line) || /^kr\s*[:.]?\s*\d+/i.test(line)) {
      packagePrice = normalizeKr(line);
      continue;
    }
    if (line.length > 1 && !looksLikeContactOrLetterhead(line)) included.push(line);
  }

  if (!included.length && !extras.length) return null;
  const categories = [];
  if (included.length) {
    categories.push({
      name: "Tapas",
      products: [
        {
          name: "Tapas",
          price: packagePrice,
          included,
          description: packagePrice ? `Pakkepris ${packagePrice} per person` : "",
        },
      ],
    });
  }
  if (extras.length) categories.push({ name: "Tillegg", products: extras });
  return {
    layout: "meny",
    label: "Tapas",
    categories,
    confidence: "high",
    source: "tapas-package",
  };
}

/** Koldtbord: Alternativ N ... Kr: price, plus tillegg. */
function explodeRunOnMenuText(text = "") {
  return String(text || "")
    .replace(/(?<![Ss]om)\s+(Alternativ\s*\d+)/g, "\n$1\n")
    .replace(/\s+((?:I\s+)?[Tt]illegg[^\n:]{0,48}:?)/g, "\n$1\n")
    .replace(/\s+(Kr\s*[:.]\s*\d+)/gi, "\n$1")
    .replace(/(\d+\s*,-)\s+(?=[A-ZÆØÅ])/g, "$1\n")
    .replace(/\s+(Du kan )/gi, "\n$1");
}

function splitPackedDishLine(line = "") {
  const text = compact(line);
  if (!text || /\d/.test(text)) return [text].filter(Boolean);
  return text
    .replace(/(\S)\s+(?=[A-ZÆØÅ][a-zæøå]{2,})/g, "$1\n")
    .split("\n")
    .map((entry) => compact(entry))
    .filter(Boolean);
}

export function parseKoldtbordText(text = "") {
  const raw = explodeRunOnMenuText(text);
  if (!/koldtbord/i.test(raw)) return null;
  const lines = raw
    .split(/\r?\n/)
    .map((line) => compact(line))
    .filter((line) => line && !/^--\s*\d+/i.test(line) && !/^koldtbord$/i.test(line) && !/^===\s*/.test(line));

  const packages = [];
  const extras = [];
  let current = null;
  let inExtras = false;
  let notes = [];

  for (const line of lines) {
    if (/^(i\s+)?tillegg/i.test(line)) {
      inExtras = true;
      if (current?.included?.length) {
        packages.push(current);
        current = null;
      }
      const rest = compact(line.replace(/^(i\s+)?tillegg[^:]*:?\s*/i, ""));
      if (rest) {
        const priced = parsePriceLine(rest.replace(/:\s+(\d)/, " $1"));
        if (priced && !looksLikeContactOrLetterhead(priced.name)) extras.push(priced);
      }
      continue;
    }
    const altMatch = line.match(/^alternativ\s*\d+\b/i);
    if (altMatch && !/samme som/i.test(line)) {
      if (current?.included?.length || current?.description) packages.push(current);
      current = { name: compact(altMatch[0]).replace(/^\w/, (ch) => ch.toUpperCase()), included: [], price: "", description: "" };
      inExtras = false;
      const rest = compact(line.slice(altMatch[0].length));
      if (rest) {
        if (/^samme som/i.test(rest)) current.description = rest;
        else current.included.push(...splitPackedDishLine(rest));
      }
      continue;
    }
    if (inExtras) {
      if (looksLikeContactOrLetterhead(line)) continue;
      const priced = parsePriceLine(line.replace(/:\s+(\d)/, " $1"));
      if (priced) {
        if (looksLikeContactOrLetterhead(priced.name)) continue;
        extras.push(priced);
      } else if (/du kan|blande|tapas|ønsker/i.test(line)) notes.push(line);
      continue;
    }
    if (/^kr\s*[:.]?\s*\d+/i.test(line) || looksLikePriceCell(line)) {
      if (current) current.price = normalizeKr(line);
      continue;
    }
    if (looksLikeContactOrLetterhead(line)) continue;
    if (current) {
      if (/^samme som/i.test(line) || current.description) {
        current.description = compact(`${current.description} ${line}`);
      } else {
        current.included.push(...splitPackedDishLine(line));
      }
    }
  }
  if (current?.included?.length || current?.description) packages.push(current);

  // Alternativ 2 often says "same as 1, plus …" without repeating included — copy from alt1.
  const alt1 = packages.find((p) => /alternativ\s*1/i.test(p.name));
  for (const pkg of packages) {
    if (/alternativ\s*2/i.test(pkg.name) && alt1?.included?.length && pkg.included.length <= 1) {
      const extraNote = pkg.description || pkg.included.join(" ");
      pkg.included = [...alt1.included];
      if (extraNote) {
        pkg.description = extraNote;
        const addOn = compact(extraNote.replace(/^samme som alternativ 1,?\s*(men\s*med)?\s*/i, ""));
        if (addOn && !pkg.included.some((item) => productNameKey(item) === productNameKey(addOn))) {
          pkg.included.push(addOn);
        }
      }
    }
  }

  if (!packages.length && !extras.length) return null;
  const categories = [];
  if (packages.length) {
    categories.push({
      name: "Koldtbord",
      products: packages.map((pkg) => ({
        name: pkg.name,
        price: pkg.price,
        included: pkg.included,
        description: pkg.description || (notes[0] || ""),
      })),
    });
  }
  if (extras.length) categories.push({ name: "Tillegg", products: extras });
  return {
    layout: "meny",
    label: "Koldtbord",
    categories,
    confidence: "high",
    source: "koldtbord-package",
  };
}

/** Cake price lists with size section headers. Dedupes repeated blocks. */
export function parseCakePriceListText(text = "") {
  const raw = String(text || "");
  if (!/kake|kaker/i.test(raw)) return null;
  const lines = raw
    .split(/\r?\n/)
    .map((line) => compact(line))
    .filter((line) => line && !/^===\s*/.test(line));

  let sizeSubtitle = "";
  const products = [];
  const seen = new Set();

  for (const line of lines) {
    if (/^kaker/i.test(line) && !/\d/.test(line)) continue;
    const sizeHeader = line.match(/^(\d+\s*cm\b.*)$/i) || line.match(/^(\d+\s*cm)\s+(\d.*stk.*)$/i);
    if (/^\d+\s*cm\b/i.test(line) && !parsePriceLine(line)) {
      // "28 cm 18-20 stk" or "26 cm"
      sizeSubtitle = line;
      continue;
    }
    if (sizeHeader && !/\d+[.,]?\d*\s*(,-|kr)/i.test(line)) {
      sizeSubtitle = compact(line);
      continue;
    }
    const priced = parsePriceLine(line);
    if (!priced) continue;
    const key = `${productNameKey(priced.name)}|${productNameKey(sizeSubtitle)}|${priced.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    products.push({
      name: priced.name,
      price: priced.price,
      subtitle: sizeSubtitle,
    });
  }

  if (!products.length) return null;
  return {
    layout: "normal",
    label: "Kaker",
    categories: [{ name: "Kaker", products }],
    confidence: "high",
    source: "cake-price-list",
  };
}

function catalogFromParsed(parsed) {
  if (!parsed?.categories?.length) return null;
  return {
    layout: parsed.layout || "meny",
    label: parsed.label || "Meny",
    categories: parsed.categories,
  };
}

/**
 * Build high-confidence catalogs + allergen rows from extracted file texts.
 */
export function buildDeterministicImportFromTexts(textChunks = []) {
  const catalogs = [];
  const allergenRows = [];
  const sources = [];

  for (const chunk of Array.isArray(textChunks) ? textChunks : []) {
    const fileName = String(chunk?.fileName || "");
    const text = String(chunk?.text || "");
    if (!text.trim()) continue;

    const lowerName = fileName.toLowerCase();
    const isAllergenFile = /allergi/.test(lowerName) || /^allergi/im.test(text);
    if (isAllergenFile) {
      const rows = parseAllergenSheetText(text);
      if (rows.length) {
        allergenRows.push(...rows);
        sources.push({ fileName, kind: "allergen-sheet", count: rows.length });
      }
      continue;
    }

    const parsers = [];
    // Filename wins; prefer specific catering types before generic "catering".
    if (/koldtbord/.test(lowerName) || (/koldtbord/i.test(text) && !/tapas/i.test(lowerName))) {
      parsers.push((value) => parseKoldtbordText(value));
    }
    if (/tapas/.test(lowerName) || /^tapas\s*$/im.test(text)) {
      parsers.push((value) => parseTapasMenuText(value, { fileName }));
    }
    if (/kake|prisliste/.test(lowerName) || /kaker\s*[–-]\s*priser/i.test(text)) {
      parsers.push((value) => parseCakePriceListText(value));
    }
    if (/cafe|meny|menu/.test(lowerName) || /===\s*TABLE/i.test(text)) {
      parsers.push((value) => parseCafeDualPriceTableText(value));
    }
    if (/catering/.test(lowerName) && !parsers.length) {
      parsers.push((value) => parseKoldtbordText(value), (value) => parseTapasMenuText(value, { fileName }));
    }

    // Content-based fallback when filename didn't hint.
    if (!parsers.length) {
      parsers.push(
        (value) => parseKoldtbordText(value),
        (value) => parseTapasMenuText(value, { fileName }),
        (value) => parseCafeDualPriceTableText(value),
        (value) => parseCakePriceListText(value)
      );
    }

    let matched = false;
    for (const parse of parsers) {
      const parsed = parse(text);
      const catalog = catalogFromParsed(parsed);
      if (!catalog) continue;
      catalogs.push(catalog);
      sources.push({ fileName, kind: parsed.source, categories: catalog.categories.length });
      matched = true;
      break;
    }
    if (!matched && /allergi/i.test(text)) {
      const rows = parseAllergenSheetText(text);
      if (rows.length) {
        allergenRows.push(...rows);
        sources.push({ fileName, kind: "allergen-sheet", count: rows.length });
      }
    }
  }

  return { catalogs, allergenRows, sources };
}

function findAllProductsInCatalogs(catalogs, name) {
  const hits = [];
  if (!productNameKey(name)) return hits;
  for (const catalog of catalogs) {
    for (const category of catalog.categories || []) {
      for (const product of category.products || []) {
        if (productNamesMatch(name, product.name)) hits.push({ catalog, category, product });
      }
    }
  }
  return hits;
}

function findProductInCatalogs(catalogs, name) {
  const hits = findAllProductsInCatalogs(catalogs, name);
  if (!hits.length) return null;
  let best = null;
  for (const hit of hits) {
    const score =
      (hit.product.price ? 2 : 0) +
      (productNameKey(name) === productNameKey(hit.product.name) ? 5 : 1) +
      Math.min(productNameKey(hit.product.name).length, 20) / 20;
    if (!best || score > best.score) best = { ...hit, score };
  }
  return best;
}

function mergeAllergenRowsIntoCatalogs(catalogs, allergenRows = []) {
  const list = catalogs.map((catalog) => ({
    ...catalog,
    categories: (catalog.categories || []).map((category) => ({
      ...category,
      products: (category.products || []).map((product) => ({ ...product })),
    })),
  }));
  const matchedRows = new Set();

  for (const row of allergenRows) {
    const hits = findAllProductsInCatalogs(list, row.name);
    if (!hits.length) continue;
    matchedRows.add(row);
    for (const hit of hits) {
      if (!row.allergens) continue;
      hit.product.allergens = hit.product.allergens
        ? Array.from(new Set(`${hit.product.allergens}; ${row.allergens}`.split(/\s*;\s*/).map(compact).filter(Boolean))).join("; ")
        : row.allergens;
    }
  }

  const leftoversByCategory = new Map();
  for (const row of allergenRows) {
    const key = productNameKey(row.name);
    if (!key) continue;
    if (matchedRows.has(row)) continue;
    // Also skip if a strict name match exists against any leftover-bound product already in catalogs
    if (findProductInCatalogs(list, row.name)) continue;
    const guessed = guessAllergenCategory(row.name);
    const existingNames = list.flatMap((catalog) => (
      (catalog.layout === "tiers" ? [] : (catalog.categories || [])).map((category) => category.name)
    )).filter((name) => {
      const role = offeringRole(name);
      return name && role !== "plans" && role !== "diet";
    });
    const categoryName = existingNames.find((name) => productNameKey(name) === productNameKey(guessed))
      || existingNames.find((name) => productNameKey(name) === productNameKey(row.sourceCategory))
      || existingNames.find((name) => !isDietOrVariantLabel(name))
      || "Meny";
    if (!leftoversByCategory.has(categoryName)) leftoversByCategory.set(categoryName, []);
    leftoversByCategory.get(categoryName).push({
      name: row.name,
      allergens: row.allergens,
      description: row.allergens ? `Allergener: ${row.allergens}` : "",
      price: "",
    });
  }

  if (leftoversByCategory.size) {
    let target = list.find((catalog) => catalog.layout === "meny") || list[0];
    if (!target) {
      target = { layout: "meny", label: "Meny", categories: [] };
      list.unshift(target);
    }
    for (const [categoryName, products] of leftoversByCategory.entries()) {
      let category = target.categories.find((entry) => productNameKey(entry.name) === productNameKey(categoryName));
      if (!category) {
        category = { name: categoryName, products: [] };
        target.categories.push(category);
      }
      const existing = new Set(category.products.map((product) => productNameKey(product.name)));
      for (const product of products) {
        const key = productNameKey(product.name);
        if (existing.has(key)) continue;
        existing.add(key);
        category.products.push(product);
      }
    }
  }

  return list;
}

function enrichFromAi(deterministicCatalogs, aiCatalogs = []) {
  const out = deterministicCatalogs.map((catalog) => ({
    ...catalog,
    categories: (catalog.categories || []).map((category) => ({
      ...category,
      products: (category.products || []).map((product) => ({ ...product })),
    })),
  }));

  for (const aiCatalog of aiCatalogs) {
    for (const aiCategory of aiCatalog.categories || []) {
      for (const aiProduct of aiCategory.products || []) {
        const hit = findProductInCatalogs(out, aiProduct.name);
        if (!hit) continue;
        // Prefer deterministic prices/included/subtitle; fill blanks from AI.
        if (!hit.product.comparePrice && aiProduct.comparePrice) hit.product.comparePrice = aiProduct.comparePrice;
        if (!hit.product.price && aiProduct.price) hit.product.price = aiProduct.price;
        if (!hit.product.subtitle && aiProduct.subtitle) hit.product.subtitle = aiProduct.subtitle;
        if (!hit.product.description && aiProduct.description) hit.product.description = aiProduct.description;
        if (!hit.product.allergens && aiProduct.allergens) hit.product.allergens = aiProduct.allergens;
        if (!(hit.product.included || []).length && (aiProduct.included || []).length) {
          hit.product.included = [...aiProduct.included];
        }
      }
    }
  }
  return out;
}

/**
 * Prefer deterministic catalogs when confident; merge allergen sheets; enrich blanks from AI.
 */
export function reconcileDeterministicWithAi({ deterministic = {}, aiCatalogs = [] } = {}) {
  const detCatalogs = Array.isArray(deterministic.catalogs) ? deterministic.catalogs : [];
  const allergenRows = Array.isArray(deterministic.allergenRows) ? deterministic.allergenRows : [];

  if (!detCatalogs.length) {
    return mergeAllergenRowsIntoCatalogs(aiCatalogs, allergenRows);
  }

  const enriched = enrichFromAi(detCatalogs, aiCatalogs);
  return mergeAllergenRowsIntoCatalogs(enriched, allergenRows);
}

export {
  productNameKey,
  normalizeKr,
  mergeAllergenRowsIntoCatalogs,
};
