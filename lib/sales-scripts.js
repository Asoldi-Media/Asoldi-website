export const SALES_SCRIPTS = [
  {
    id: 'ny-mote-tid',
    name: 'Ny møte tid',
    body: [
      'hei snakker jeg med [eier], så hyggelig, en kollega av meg ringte dere for [tidspunkt for forrige møte], og det var snakk om det å forhåndsvise en nettside som vi har laget til dere, ringer det noen bjeller for deg? ja det var [bård] som ringte, og det har seg sånn at det tokk litt lenger tid å få satt opp det nettside designet enn vi trodde, men nå er den på plass og klar, så jeg lurte egentlig bare på om det hadde vært mulig å ta et møte en gang denne uken, muligens om: [ledig tid]?',
      '',
      '[hvis de hadde booket Irl møte: spør pent om å få byttet over til meet, da det sparer begge parter tid] møtet blir over google meet så sender jeg over en bekreftelses epost forløpende så sees vi da [navn] :)',
    ].join('\n'),
  },
];

export function salesScriptCount() {
  return SALES_SCRIPTS.length;
}

export function getSalesScriptById(id = '') {
  return SALES_SCRIPTS.find((script) => script.id === id) || SALES_SCRIPTS[0] || null;
}
