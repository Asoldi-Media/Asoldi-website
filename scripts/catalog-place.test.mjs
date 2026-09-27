import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDietOrVariantLabel,
  offeringRole,
  placeIncomingCatalogs,
  similarHeading,
  harvestHeadings,
} from '../lib/ai-assistant/catalog-place.js';
import { mergeImportedCatalogs } from '../lib/client-product-catalog.js';

test('diet labels are not offering groups', () => {
  assert.equal(isDietOrVariantLabel('Glutenfritt'), true);
  assert.equal(isDietOrVariantLabel('GLUTEN-FRITT'), true);
  assert.equal(offeringRole('Glutenfri pizza'), 'diet');
  assert.equal(offeringRole('Drikke'), 'drikke');
  assert.equal(offeringRole('Kaker'), 'kaker');
});

test('new sources place against website headings by similar leftover names', () => {
  const website = [{
    layout: 'meny',
    label: 'Meny',
    origin: 'website',
    categories: [
      { name: 'Sandwiches', products: [{ title: 'Shrimp', price: '12' }] },
      { name: 'Drinks', products: [{ title: 'Coffee', price: '4' }] },
    ],
  }];
  const headings = harvestHeadings(website);
  assert.equal(similarHeading('Dietary menu sandwiches', headings).name, 'Sandwiches');
  const placed = placeIncomingCatalogs(website, [{
    layout: 'meny',
    label: 'Dietary sheet 1',
    origin: 'document',
    sourceName: 'Dietary sheet 1.odt',
    categories: [
      { name: 'Dietary menu sandwiches', products: [{ title: 'Shrimp', allergens: 'Shellfish' }] },
    ],
  }]);
  const names = placed.flatMap((catalog) => (catalog.categories || []).map((category) => category.name));
  assert.equal(names.filter((name) => /sandwich/i.test(name)).length, 1);
  assert.equal(names.some((name) => /dietary/i.test(name)), false);
  assert.equal(placed.filter((catalog) => catalog.layout === 'meny').length, 1);
});

test('allergen leftovers become products in Meny, not many diet categories', () => {
  const placed = placeIncomingCatalogs([], [{
    layout: 'meny',
    label: 'Meny',
    categories: [
      { name: 'Glutenfritt', products: [{ title: 'Grove horn', allergens: 'Egg' }] },
      { name: 'Laktosefritt', products: [{ title: 'Havregrøt', allergens: '' }] },
      { name: 'Vegetar', products: [{ title: 'Omelett', allergens: 'Egg' }] },
    ],
  }]);
  assert.equal(placed.length, 1);
  assert.equal(placed[0].categories.length, 1);
  assert.equal(placed[0].categories[0].name, 'Meny');
  assert.equal(placed[0].categories[0].products.length, 3);
});

test('a later café menu refiles allergen items into real groups', () => {
  const afterAllergen = placeIncomingCatalogs([], [{
    layout: 'meny',
    label: 'Meny',
    categories: [
      { name: 'Glutenfritt', products: [{ title: 'Omelett', allergens: 'Egg' }] },
      { name: 'Meny', products: [{ title: 'Kaffe', allergens: '' }] },
    ],
  }]);
  const afterMenu = placeIncomingCatalogs(afterAllergen, [{
    layout: 'meny',
    label: 'Meny',
    categories: [
      { name: 'Drikke', products: [{ title: 'Kaffe', price: '45 kr' }] },
      { name: 'Småretter', products: [{ title: 'Omelett', price: '135 kr' }] },
    ],
  }]);
  const names = afterMenu[0].categories.map((category) => category.name).sort();
  assert.deepEqual(names, ['Drikke', 'Småretter']);
  const omelett = afterMenu[0].categories.find((category) => category.name === 'Småretter').products[0];
  assert.equal(omelett.price, '135 kr');
  assert.match(omelett.allergens, /Egg/i);
});

test('website tiers stay put when food arrives', () => {
  const merged = mergeImportedCatalogs(
    [{
      layout: 'tiers',
      label: 'Tiers',
      categories: [
        { name: 'Starter', products: [{ title: 'Starter', price: '999,-/mnd' }] },
        { name: 'Vekst', products: [{ title: 'Vekst', price: '2999,-/mnd' }] },
      ],
    }],
    [{
      layout: 'meny',
      label: 'Meny',
      categories: [
        { name: 'Glutenfritt', products: [{ title: 'Ciabatta', allergens: 'Gluten' }] },
      ],
    }],
  );
  assert.equal(merged.some((catalog) => catalog.layout === 'tiers'), true);
  const food = merged.find((catalog) => catalog.layout === 'meny');
  assert.ok(food);
  assert.equal(food.categories.length, 1);
  assert.equal(food.categories[0].name, 'Meny');
  assert.equal(food.categories[0].products[0].title, 'Ciabatta');
});

test('allergen-file catalogs fold into the real shop group, not a second Smørbrød', () => {
  const stale = placeIncomingCatalogs([], [{
    layout: 'meny',
    label: 'Allergi-meny',
    categories: [
      { name: 'Allergi meny smørbrød', products: [{ title: 'Reke', allergens: 'Reker' }] },
    ],
  }, {
    layout: 'meny',
    label: 'Meny',
    origin: 'website',
    categories: [
      { name: 'Smørbrød', products: [{ title: 'Reke', price: '125 kr' }] },
      { name: 'Drikke', products: [{ title: 'Kaffe', price: '45 kr' }] },
    ],
  }]);
  const names = stale.flatMap((catalog) => (catalog.categories || []).map((category) => category.name));
  assert.equal(names.filter((name) => /smørbrød/i.test(name)).length, 1);
  assert.equal(names.some((name) => /allergi/i.test(name)), false);
  assert.equal(stale.filter((catalog) => catalog.layout === 'meny').length, 1);

  const cleaned = placeIncomingCatalogs(stale, []);
  const cleanedNames = cleaned.flatMap((catalog) => (catalog.categories || []).map((category) => `${catalog.label} · ${category.name}`));
  assert.equal(cleanedNames.some((name) => /allergi/i.test(name)), false);
  assert.equal(cleaned.find((catalog) => catalog.layout === 'meny').categories.find((category) => category.name === 'Smørbrød').products[0].price, '125 kr');
});

test('attribute-sheet leftovers do not invent aisles when a shop tree exists', () => {
  const placed = placeIncomingCatalogs([{
    layout: 'meny',
    label: 'Meny',
    origin: 'website',
    categories: [
      { name: 'Smørbrød', products: [{ title: 'Reke', price: '125 kr' }] },
    ],
  }], [{
    layout: 'meny',
    label: 'Sheet',
    source: 'allergen-sheet',
    categories: [
      { name: 'Glutenfritt', products: [{ title: 'Grove horn', allergens: 'Egg' }] },
      { name: 'Allergi meny smørbrød', products: [{ title: 'Reke', allergens: 'Reker' }] },
    ],
  }]);
  const food = placed.find((catalog) => catalog.layout === 'meny');
  const names = food.categories.map((category) => category.name);
  assert.equal(names.includes('Smørbrød'), true);
  assert.equal(names.some((name) => /gluten|allergi/i.test(name)), false);
  assert.equal(food.categories.find((category) => category.name === 'Smørbrød').products[0].allergens, 'Reker');
});

test('dessert and kaker stay separate shop groups', () => {
  const placed = placeIncomingCatalogs([], [{
    layout: 'meny',
    label: 'Meny',
    categories: [
      { name: 'Dessert', products: [{ title: 'Iscup', price: '45 kr' }] },
      { name: 'Kaker', products: [{ title: 'Eplekake', price: '55 kr' }] },
    ],
  }]);
  const names = placed[0].categories.map((category) => category.name).sort();
  assert.deepEqual(names, ['Dessert', 'Kaker']);
});
