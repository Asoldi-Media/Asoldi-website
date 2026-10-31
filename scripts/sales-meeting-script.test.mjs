import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modal = readFileSync(join(root, 'app/pages/sales/MeetingNotesModal.tsx'), 'utf8');
const popup = readFileSync(join(root, 'app/pages/sales/SalesProjectsPopup.tsx'), 'utf8');

test('bli kjent starts with intro, projects link, and second-party question', () => {
  const bliKjent = modal.slice(modal.indexOf("title: 'Bli kjent'"), modal.indexOf("title: 'Fremvisning'"));
  assert.match(bliKjent, /Introduksjon av oss generelt/);
  assert.match(bliKjent, /Anmeldelser og/);
  assert.match(bliKjent, /action: 'projects'/);
  assert.match(bliKjent, /andrepart/);
  assert.ok(bliKjent.indexOf('Introduksjon') < bliKjent.indexOf('Anmeldelser'));
  assert.ok(bliKjent.indexOf('Anmeldelser') < bliKjent.indexOf('andrepart'));
});

test('pris script splits summary, painpoints and objections', () => {
  assert.match(modal, /Oppsummer samtalen \(hvilken tier funksjonalitet\)/);
  assert.doesNotMatch(modal, /Oppsummer samtalen og painpoints/);
  assert.match(modal, /Færre kvalifiserte kunder/);
  assert.match(modal, /For dyrt/);
  assert.match(modal, /Jeg kan gjøre det selv/);
  assert.match(modal, /Må snakke med noen/);
  assert.match(modal, /Må tenke på det/);
});

test('signatur script opens with link, then workshop path, then existing ask', () => {
  const signatur = modal.slice(modal.indexOf("title: 'Signatur'"), modal.indexOf("title: 'Neste steg'"));
  assert.match(signatur, /Få kunde inn på signatursiden/);
  assert.match(signatur, /Da har jeg sendt en liten lenke/);
  assert.match(signatur, /Klargjør veien fremover/);
  assert.match(signatur, /etter signering starter vi med en workshop/);
  assert.match(signatur, /For å starte prosjektet trenger vi en signatur/);
  assert.ok(signatur.indexOf('signatursiden') < signatur.indexOf('Klargjør veien fremover'));
  assert.ok(signatur.indexOf('Klargjør veien fremover') < signatur.indexOf('For å starte prosjektet'));
});

test('projects popup lists booker and homepage results without a fetch', () => {
  assert.doesNotMatch(popup, /\bfetch\b/);
  assert.match(popup, /Superhero Burger/);
  assert.match(popup, /S'wich restaurant/);
  assert.match(popup, /Svelstad gård/);
  assert.match(popup, /Mong Sushi/);
  assert.match(popup, /Værnes bar/);
  assert.match(popup, /Christopher Vrioni/);
});
