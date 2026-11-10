// The kopitiam menu. The browser uses it to draw the order form and the Worker
// uses it to validate orders, so the two can never disagree.

export const GROUPS = {
  milk: {
    label: 'Milk',
    options: [
      { id: 'condensed', word: '', label: 'Standard', hint: 'condensed milk' },
      { id: 'c', word: 'C', label: 'C', hint: 'evaporated milk' },
      { id: 'o', word: 'O', label: 'O', hint: 'no milk' },
    ],
  },
  sugar: {
    label: 'Sugar',
    options: [
      { id: 'normal', word: '', label: 'Standard', hint: 'normal sugar' },
      { id: 'siu-dai', word: 'Siu Dai', label: 'Siu Dai', hint: 'less sugar' },
      { id: 'ga-dai', word: 'Ga Dai', label: 'Ga Dai', hint: 'more sugar' },
      { id: 'kosong', word: 'Kosong', label: 'Kosong', hint: 'no sugar' },
    ],
  },
  strength: {
    label: 'Strength',
    options: [
      { id: 'normal', word: '', label: 'Standard', hint: 'normal strength' },
      { id: 'gao', word: 'Gao', label: 'Gao', hint: 'stronger' },
      { id: 'po', word: 'Po', label: 'Po', hint: 'weaker' },
      { id: 'di-lo', word: 'Di Lo', label: 'Di Lo', hint: 'extra strong' },
    ],
  },
  temp: {
    label: 'Hot or iced',
    options: [
      { id: 'hot', word: '', label: 'Hot', hint: '' },
      { id: 'peng', word: 'Peng', label: 'Peng', hint: 'iced' },
    ],
  },
};

// The order the words are said in: "Kopi O Kosong Gao Peng".
export const GROUP_ORDER = ['milk', 'sugar', 'strength', 'temp'];

const MILK = ['condensed', 'c', 'o'];
const SUGAR = ['normal', 'siu-dai', 'ga-dai', 'kosong'];
const STRENGTH = ['normal', 'gao', 'po', 'di-lo'];
const TEMP = ['hot', 'peng'];
const FULL = { milk: MILK, sugar: SUGAR, strength: STRENGTH, temp: TEMP };

// `options` lists what each drink can be ordered with; the first entry of each
// list is the default. `head` and `tail` wrap the milk word: "Teh O Halia".
export const DRINKS = [
  { id: 'kopi', name: 'Kopi', hint: 'coffee', options: FULL },
  { id: 'teh', name: 'Teh', hint: 'tea', options: FULL },
  { id: 'yuan-yang', name: 'Yuan Yang', hint: 'coffee + tea', options: FULL },
  {
    id: 'teh-halia',
    name: 'Teh Halia',
    hint: 'ginger tea',
    head: 'Teh',
    tail: 'Halia',
    options: { milk: MILK, sugar: SUGAR, temp: TEMP },
  },
  {
    id: 'milo',
    name: 'Milo',
    hint: 'chocolate malt',
    options: { sugar: ['normal', 'siu-dai', 'kosong'], strength: ['normal', 'gao'], temp: TEMP },
  },
  {
    id: 'horlicks',
    name: 'Horlicks',
    hint: 'malt drink',
    options: { sugar: ['normal', 'siu-dai', 'kosong'], strength: ['normal', 'gao'], temp: TEMP },
  },
  { id: 'diao-yu', name: 'Diao Yu', hint: 'Chinese tea', options: { temp: TEMP } },
];

const findDrink = (id) => DRINKS.find((d) => d.id === id);

// Returns a clean { base, milk, sugar, ... } with defaults filled in, or null
// if the drink or any chosen option is not on the menu.
export function validateDrink(input) {
  const drink = findDrink(input?.base);
  if (!drink) return null;
  const clean = { base: drink.id };
  for (const group of GROUP_ORDER) {
    const allowed = drink.options[group];
    if (!allowed) continue;
    const choice = input[group] ?? allowed[0];
    if (!allowed.includes(choice)) return null;
    clean[group] = choice;
  }
  return clean;
}

// Switches to another drink, keeping the choices that drink also offers.
export function withBase(order, base) {
  const { options } = findDrink(base);
  const next = { base };
  for (const group of GROUP_ORDER) {
    if (options[group]) next[group] = options[group].includes(order[group]) ? order[group] : options[group][0];
  }
  return next;
}

// Expects a validated order.
export function drinkName(order) {
  const drink = findDrink(order.base);
  const word = (group) => GROUPS[group].options.find((o) => o.id === order[group])?.word;
  const after = GROUP_ORDER.filter((group) => group !== 'milk').map(word);
  return [drink.head ?? drink.name, word('milk'), drink.tail, ...after].filter(Boolean).join(' ');
}
