# Direzione visiva di helmcode

Il prodotto è uno strumento desktop per lavorare con codice, terminali e Git.
La priorità è leggere a lungo e distinguere rapidamente contenuto, navigazione
e azioni, mantenendo l'identità del timone e della salvia.

## Piano

- Scuro: canvas `#14191d`, chrome `#1b2227`, superficie `#1a2025`, testo
  `#e4ebe7`, secondario `#b2c0b9`, accento `#9bd6bd`.
- Chiaro: canvas `#fbfcfb`, chrome `#eaf0ee`, superficie `#f1f4f3`, testo
  `#243b34`, secondario `#536b61`, accento `#256c52`.
- Testi UI: Segoe UI Variable Text, nativo su Windows; titoli: Bahnschrift
  con ripiego Segoe UI Variable Display; codice: Cascadia Code e Consolas.
- Icone: griglia comune, tratto arrotondato coerente, geometrie semplificate
  alle dimensioni effettive. Il branch del footer non incorpora altri simboli.
- La gerarchia viene da contrasto, spazio e peso dei testi; le cornici separano
  strumenti e contenuti, senza trasformare ogni elemento in una scheda.

```text
Progetti                           Workspace
┌─ brand / azioni finestra ───┐    ┌─ progetto / modalità / azioni ────┐
│ Azioni progetto │ Recenti  │    │ strumenti │ file │ editor         │
│ allineate       │ percorsi │    │           │      ├─ terminali ────┤
│ a sinistra      │          │    ├─ branch / problemi / stato ────────┤
└────────────────────────────┘    └────────────────────────────────────┘
```

## Riesame prima dell'implementazione

Una schermata di benvenuto con grandi immagini o una raccolta di schede sarebbe
decorativa e poco utile in un IDE. Si conserva quindi il layout operativo:
il carattere distintivo resta nella salvia, nel timone e nella tipografia,
con maggiore disciplina sulle superfici e sui piccoli comandi.

Il tema chiaro richiede colori propri per testo, sintassi, icone dei file e ANSI;
non viene ottenuto invertendo il tema scuro. Il cambio avviene sul posto e
preserva documenti, selezioni, undo e sessioni terminale. La splash resta
all'avvio normale, senza dissolvenza; “Nuova finestra” continua a saltarla.

La skill applicata è la versione pubblica di
[frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md),
non presente nelle skill installate localmente.

## Uso e verifica

Il tema si sceglie in **Impostazioni → Aspetto**. Scuro è il valore iniziale
per conservare la preferenza degli utenti esistenti; Chiaro e Sistema vengono
ricordati e sincronizzati fra finestre. Non vengono scaricati font o librerie
di icone durante l'uso.

Verificati 92 test JavaScript, inclusi contrasto di testo e palette ANSI,
risoluzione e memorizzazione del tema e conservazione di selezione/undo.
Lo smoke test esercita 67 scenari in Chrome con il trasporto desktop simulato,
compresi cambio live Scuro/Chiaro/Sistema, editor e PTY conservati, palette
applicata prima dell'apertura della finestra e impostazioni a dimensioni ridotte.
Le schermate di verifica sono salvate in `.qa/appearance-*.png`.
Compilato anche l'eseguibile Windows standalone aggiornato in
`release/helmcode-optimized.exe`, con frontend e permessi per il tema nativo incorporati.

```powershell
npm run build
npm test
npm run test:ui
```
