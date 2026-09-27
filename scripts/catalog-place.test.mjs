import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDietOrVariantLabel,
  offeringRole,
  placeIncomingCatalogs,
} from '../lib/ai-assistant/catalog-place.js';
import { mergeImportedCatalogs } from '../lib/client-product-catalog.js';

test('diet labels are not offering groups', () => {
  assert.equal(isDietOrVariantLabel('Glutenfritt'), true);
  assert.equal(isDietOrVariantLabel('GLUTEN-FRITT'), true);
  assert.equal(offeringRole('Glutenfri pizza'), 'diet');
  assert.equal(offeringRole('Drikke'), 'drikke');
  assert.equal(offeringRole('Kaker'), 'kaker');
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
