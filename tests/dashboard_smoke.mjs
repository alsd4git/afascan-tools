import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const [htmlPath, mode = 'empty'] = process.argv.slice(2);
if (!htmlPath) throw new Error('Uso: node tests/dashboard_smoke.mjs dashboard.html [empty|sample]');

const records = mode === 'sample' ? [
  {
    date: '2026-08-30', source_file: 'first.png', report_type: 'body_composition',
    weight_kg: 80, body_fat_percent: 20, skeletal_muscle_mass_kg: 40,
    body_fat_mass_kg: 16, muscle_mass_kg: 60, bone_mass_kg: 3, target_weight_kg: 75,
    basal_metabolic_rate_kcal: 1700, visceral_fat_level: 10, protein_percent: 14,
    water_percent: 52, score: 70, segment_fat_kg: {right_arm: 1, left_arm: 1, trunk: 10, right_leg: 2, left_leg: 2},
    segment_lean_kg: {right_arm: 3, left_arm: 3, trunk: 28, right_leg: 9, left_leg: 9}
  },
  {
    date: '2026-08-30', source_file: 'second.png', report_type: 'body_composition',
    weight_kg: null, body_fat_percent: null, skeletal_muscle_mass_kg: 41,
    body_fat_mass_kg: null, muscle_mass_kg: 61, bone_mass_kg: 3, target_weight_kg: 75,
    basal_metabolic_rate_kcal: 1705, visceral_fat_level: 9, protein_percent: 14,
    water_percent: 53, score: 71, segment_fat_kg: {right_arm: null, left_arm: 1, trunk: 9, right_leg: 2, left_leg: 2},
    segment_lean_kg: {right_arm: 3, left_arm: 3, trunk: 28, right_leg: 9, left_leg: 9}
  }
] : [];

let html = readFileSync(htmlPath, 'utf8');
html = html.replace(
  /(<script type="application\/json" id="measurements-data">)[\s\S]*?(<\/script>)/,
  `$1${JSON.stringify(records)}$2`,
);
const script = html.match(/<script>\r?\n([\s\S]*?)\r?\n<\/script>/)?.[1];
if (!script) throw new Error('Script dashboard non trovato');

const elements = new Map();
const element = (id = '') => ({
  id, textContent: '', innerHTML: '', value: '', disabled: false, children: [],
  addEventListener() {}, appendChild(child) { this.children.push(child); },
});
const document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  },
  createElement: () => element(),
};
const dataElement = element('measurements-data');
dataElement.textContent = JSON.stringify(records);
elements.set('measurements-data', dataElement);
vm.runInNewContext(script, { document, console });
for (const item of elements.values()) {
  if (`${item.textContent} ${item.innerHTML}`.includes('NaN') || `${item.textContent} ${item.innerHTML}`.includes('undefined')) {
    throw new Error('Dashboard contiene NaN o undefined');
  }
}

if (mode === 'empty') {
  if (elements.get('subtitle').textContent !== 'Nessun referto importato') throw new Error('Stato vuoto non renderizzato');
  if (!elements.get('metric').disabled || !elements.get('detail-date').disabled) throw new Error('Controlli vuoti non disabilitati');
} else {
  if (elements.get('detail-date').children.length !== 2) throw new Error('Date duplicate non distinguibili');
  if (elements.get('detail-date').children[0].value === elements.get('detail-date').children[1].value) throw new Error('Chiavi dettaglio duplicate');
  if (elements.get('summary').innerHTML.includes('-80')) throw new Error('Null interpretato come delta numerico');
  if ((elements.get('chart').innerHTML.match(/<circle /g) || []).length !== 1) throw new Error('Null disegnato come punto del grafico');
  if (!elements.get('details-content').innerHTML.includes('— kg')) throw new Error('Valore mancante non mostrato come —');
}
