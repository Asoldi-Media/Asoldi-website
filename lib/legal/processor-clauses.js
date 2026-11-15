/**
 * The clauses in which Asoldi appears as processor (databehandler) on a client's site, for the
 * privacy page the client CMS generates. The CMS reads them through the site-authenticated route in
 * lib/routes/legal-clause-routes.js and caches the last answer.
 *
 * One source: the processor register (lib/legal/hosts-register.json, through subprocessors.js) names
 * the sub-processors and the LLM data policy names the AI providers, so a clause never lists a
 * provider the register does not know. These clauses do not change the catalog texts of lib/legal/
 * catalog.js; they have their own version.
 *
 * A clause is { id, version, appliesWhen, processing, uses, nb, en }:
 *   - appliesWhen: null (always) or a list of feature keys; the clause is returned when one of them
 *     is among the features the CMS reports as effective;
 *   - processing: the processing features the clause covers (PROCESSING_FEATURES);
 *   - uses: register processor ids the clause relies on; the answer lists them with their details;
 *   - nb / en: { title, paragraphs[] }.
 *
 * PROCESSING_FEATURES lists every feature that changes how Asoldi processes a client's data.
 * processingGaps() names each one that has no clause; scripts/legal-catalog.test.mjs fails on a gap,
 * so a new feature that processes data cannot ship without a clause.
 *
 * Pure apart from reading the register and the LLM policy once.
 */
import { createHash } from 'node:crypto';
import { DPA_VERSION } from './catalog.js';
import { HOSTS_REGISTER, llmProviderRows, subprocessorList } from './subprocessors.js';

export const PROCESSOR_CLAUSES_VERSION = 1;
export const PROCESSOR_LANGUAGES = Object.freeze(['nb', 'en']);

/** Features that change how Asoldi processes a client's data. */
export const PROCESSING_FEATURES = Object.freeze(['hosting', 'backups', 'changeRequests', 'devAgent', 'iterationProcessing']);

const PROCESSOR_NAME = 'Asoldi Markedsføring (drevet under foretaket CHAPANA, org.nr. 934 327 497)';

const DECLARED = [
  {
    id: 'processor.base',
    version: 1,
    appliesWhen: null,
    processing: ['hosting', 'backups'],
    uses: ['hostinger'],
    nb: {
      title: 'Asoldi som databehandler',
      paragraphs: [
        `${PROCESSOR_NAME} drifter og vedlikeholder dette nettstedet og behandler personopplysninger på vegne av oss etter en databehandleravtale (versjon ${DPA_VERSION}). Asoldi behandler opplysningene bare etter vår instruks og til de formålene som er nevnt her.`,
        'Nettstedet og dataene i det ligger hos Hostinger (EØS). Det tas sikkerhetskopier av nettstedets data. De slettes automatisk etter kort tid, og en sletting når sikkerhetskopiene først når de utløper.',
        'Asoldi har bare tilgang til personopplysninger når det trengs for drift, feilretting eller en forespørsel fra oss, og tilgangen logges.',
      ],
    },
    en: {
      title: 'Asoldi as processor',
      paragraphs: [
        `${PROCESSOR_NAME} runs and maintains this website and processes personal data on our behalf under a data processing agreement (version ${DPA_VERSION}). Asoldi processes the data only on our instructions and for the purposes stated here.`,
        'The website and its data are hosted by Hostinger (EEA). Backups of the website data are taken. They are deleted automatically after a short time, and an erasure reaches the backups only when they expire.',
        'Asoldi has access to personal data only when needed for operation, fixing faults or a request from us, and the access is logged.',
      ],
    },
  },
  {
    id: 'processor.changeRequests',
    version: 1,
    appliesWhen: ['changeRequests'],
    processing: ['changeRequests'],
    uses: [],
    nb: {
      title: 'Endringsforespørsler til Asoldi',
      paragraphs: [
        'Når vi sender en endringsforespørsel til Asoldi fra administrasjonen, lagrer Asoldi teksten, eventuelle vedlegg og hvem som sendte den. Det kan inneholde personopplysninger hvis vi selv skriver dem inn.',
        'Forespørslene brukes bare til å utføre og dokumentere endringen, og slettes etter {changeMonths} måneder.',
      ],
    },
    en: {
      title: 'Change requests to Asoldi',
      paragraphs: [
        'When we send a change request to Asoldi from the admin, Asoldi stores the text, any attachments and who sent it. It can contain personal data if we enter it ourselves.',
        'The requests are used only to carry out and document the change, and are deleted after {changeMonths} months.',
      ],
    },
  },
  {
    id: 'processor.devAgent',
    version: 1,
    appliesWhen: ['changeRequests'],
    processing: ['devAgent'],
    uses: ['anthropic', 'google'],
    nb: {
      title: 'Automatisk behandling av endringer',
      paragraphs: [
        'Asoldi bruker språkmodeller til å utføre endringer på nettstedet. Teksten i en endringsforespørsel og innholdet på sidene det gjelder kan da sendes til en språkmodell. Opplysninger om besøkende og kunder i nettbutikken sendes ikke dit.',
        'Språkmodellene som kan få personopplysninger, er {providers}. Andre språkmodeller får bare offentlige eller anonymiserte data.',
      ],
    },
    en: {
      title: 'Automatic handling of changes',
      paragraphs: [
        'Asoldi uses language models to carry out changes on the website. The text of a change request and the content of the pages concerned can then be sent to a language model. Data about visitors and web shop customers is not sent there.',
        'The language models that may receive personal data are {providers}. Other language models receive only public or anonymised data.',
      ],
    },
  },
  {
    id: 'processor.iteration',
    version: 1,
    appliesWhen: ['changeRequests'],
    processing: ['iterationProcessing'],
    uses: [],
    nb: {
      title: 'Kontroll og forbedring av endringer',
      paragraphs: [
        'Etter en endring kontrollerer Asoldi resultatet, blant annet med skjermbilder av sidene. Skjermbilder og arbeidsfiler fra slik kontroll slettes etter {screenshotDays} dager.',
      ],
    },
    en: {
      title: 'Checking and improving changes',
      paragraphs: [
        'After a change, Asoldi checks the result, including with screenshots of the pages. Screenshots and working files from such checks are deleted after {screenshotDays} days.',
      ],
    },
  },
];

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

export const PROCESSOR_CLAUSES = freeze(JSON.parse(JSON.stringify(DECLARED)));

/** A mutable copy of the declared clauses (tests build variants from it). */
export function declaredProcessorClauses() {
  return JSON.parse(JSON.stringify(DECLARED));
}

/** Processing features that no clause covers. */
export function processingGaps({ clauses = PROCESSOR_CLAUSES, required = PROCESSING_FEATURES } = {}) {
  const covered = new Set(clauses.flatMap((clause) => clause.processing || []));
  return required.filter((feature) => !covered.has(feature));
}

function providerNames(register) {
  return llmProviderRows({ register })
    .filter((row) => row.personal && row.processorId)
    .map((row) => row.name)
    .sort((a, b) => a.localeCompare(b, 'nb'));
}

function joinNames(names, language) {
  if (names.length <= 1) return names.join('');
  const word = language === 'en' ? 'and' : 'og';
  return `${names.slice(0, -1).join(', ')} ${word} ${names[names.length - 1]}`;
}

/** True when a clause applies to the reported effective features. */
export function clauseApplies(clause, features) {
  if (!clause.appliesWhen) return true;
  const set = new Set(features);
  return clause.appliesWhen.some((key) => set.has(key));
}

/**
 * The answer for one site: the clauses that apply to its effective features, in the given language,
 * and the sub-processors those clauses rely on. `features` is the list the CMS reports; keys the
 * clauses do not know are ignored. The hash covers exactly what the CMS prints.
 */
export function processorClausesFor({ features = [], language = 'nb', clauses = PROCESSOR_CLAUSES, register = HOSTS_REGISTER, params = {} } = {}) {
  const values = { changeMonths: 24, screenshotDays: 30, ...params };
  const lang = PROCESSOR_LANGUAGES.includes(language) ? language : 'nb';
  const list = (Array.isArray(features) ? features : []).map((key) => String(key).trim()).filter(Boolean);
  const providers = joinNames(providerNames(register), lang);
  const chosen = clauses.filter((clause) => clauseApplies(clause, list));
  const out = chosen.map((clause) => {
    const text = clause[lang] || clause.nb;
    return {
      id: clause.id,
      version: clause.version,
      processing: [...(clause.processing || [])],
      title: text.title,
      paragraphs: text.paragraphs.map((paragraph) => paragraph
        .replace('{providers}', providers)
        .replace('{changeMonths}', String(values.changeMonths))
        .replace('{screenshotDays}', String(values.screenshotDays))),
    };
  });
  const used = new Set(chosen.flatMap((clause) => clause.uses || []));
  const subprocessors = subprocessorList({ scope: 'client', register })
    .filter((entry) => used.has(entry.id))
    .map((entry) => ({ id: entry.id, name: entry.name, entity: entry.entity, region: entry.region, transfer: entry.transfer, role: entry.role }));
  const body = { version: PROCESSOR_CLAUSES_VERSION, dpaVersion: DPA_VERSION, language: lang, clauses: out, subprocessors };
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { ...body, hash };
}
