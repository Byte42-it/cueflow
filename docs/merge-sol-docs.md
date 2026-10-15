# Piano: portare in Cueflow tutto ciò che è riutilizzabile di `sol/docs`

Documento di lavoro per **Ballu e il suo Claude**, da eseguire quando è pronto. Scritto il 2026-10-14 da Luca e Claude
dopo aver letto l'export della sessione di Ballu su `sol` (`2026-10-14-153049-riprendiamo-il-lavoro-sul-sito.txt`) e il
documento di progetto "Tutorial animati per la guida di SAUL" (PDF). Chi esegue il piano ha accesso a `sol` completo
(branch `dev`, commit `e92d7968` e `c5a54655`, che nel repo di Luca **non ci sono**: non sono stati pushati) e alla
memoria `sol_docs_video_tutorial.md` di Ballu. Leggete prima quella memoria e il `CLAUDE.md` di Cueflow.

## Stato al 2026-10-15 (cosa è già in `main`)

| Passo | Stato |
|---|---|
| 1 Player | fatto: capitoli, velocità, sottotitoli e voce separati, `#step-N`, tastiera, riduci-movimento, trascrizione. **Da verificare** contro il player di `sol` che nessun comando o dettaglio manchi |
| 2 Controlli di qualità | fatto: durata massima (`maxSeconds` del brief), passi con più di due frasi, selettori, layout (`validate --layout`). Manca: avviso per parole non coperte dalla pronuncia |
| 3 Voce | fatto: voci per globale / lingua / video con ereditarietà, stile e voce OpenAI nel kit (`cueflow.json`), pronuncia nel brief, anteprima con la voce del browser, `say` e comando locale. Da decidere in `sol`: voce e stile per SAUL |
| 4 Tema e brief | fatto: `theme/`, `brief.json` |
| 5 `build_site` | fatto: catalogo, home, pagina di dettaglio, PDF, poster, modale di richiesta. **Da fare: il confronto a screenshot con la guida di `sol`** (solo chi ha `sol` aggiornato può farlo) |
| 6 Onboarding MCP | fatto: `instructions`, `get_method`, `get_brief`, `set_source`, `set_brief`, `init_kit`, `get_voices`, `set_voice` |
| 7 Cattura | fatto, da sito vivo (`capture.json`). Da cartella locale: la fa l'assistente a mano (vedi `get_method`) |
| 8 Ridurre `sol` | **da fare** |

Inoltre esistono `cueflow init` (crea `.cueflow/`, output in `cueflow-dist/`) e `cueflow studio` (editor locale).
I passi aperti sono quindi: 0 (rendere visibile `dev` di `sol`), il confronto del passo 5, e il passo 8.

## Regola che guida tutto

> **Tutto ciò che renderebbe Cueflow utilizzabile su un sito qualsiasi va in Cueflow. Ciò che vale solo per SAUL resta in `sol`.**

Nel dubbio: se un altro progetto (uno studio dentistico, un gestionale, un sito di prenotazioni) lo riscriverebbe
uguale, è di Cueflow. Se contiene il nome SAUL, i suoi colori, i suoi testi, i suoi casi d'esempio, il suo backend o le
sue promesse di prodotto, è di `sol`.

Non lasciate in `sol` una copia modificata di codice generico "per ora": il punto dell'operazione è che `sol` smetta di
avere un suo player. Alla fine `sol` contiene un **kit** (dati) e le istruzioni specifiche, non codice di motore.

| Va in **Cueflow** (generico) | Resta in **sol** (specifico) |
|---|---|
| Player: scalette dati, cursore, camera, sottotitoli, voce, tempi dati dalla durata audio | Le scalette dei tutorial SAUL (`guides/*.json`) |
| Controlli: play/pausa, barra con capitoli, ripeti passo, velocità 1×/1,5×, sottotitoli e voce separati, link `#passo-N`, tastiera, "riduci movimento", trascrizione leggibile e scaricabile | Le scene/clone dell'interfaccia SAUL (HTML con casi finti) |
| TTS con cache per impronta (testo + voce + modello + stile), generazione in anticipo, anteprima con la voce del browser | La scelta della voce, le istruzioni di stile ("collega esperto che spiega a un avvocato") |
| Dizionario di pronuncia (meccanismo e formato) | Il contenuto del dizionario (SAUL, PEC, c.c., art., sigle di legge) |
| Controllo automatico: ogni elemento nominato in una scaletta esiste ancora nella scena | Le regole di prodotto ("si mostra solo ciò che SAUL fa oggi", una sola strategia per caso, niente verifica automatica dell'atto) |
| Controlli di qualità: durata massima per tutorial (default 90 s), un'idea per passo, passi troppo lunghi | I valori scelti per SAUL, se diversi dal default |
| Shell della guida: barra a sinistra, home in stile piattaforma video con tutorial in evidenza e righe scorrevoli, fascia "in arrivo", pagina di dettaglio con video a tutta area, sommario con ricerca, gruppi Video/Approfondimenti, "Genera PDF" con copertina e indice costruiti alla stampa, poster, anteprime | Il contenuto testuale delle guide e i loro approfondimenti |
| Tema configurabile: token (colori, font, logo) letti da un file del kit, o estratti dal CSS del sito | I token SAUL (navy `#0f2142`, oro `#d49a14`, Lora/Inter), il logo SAUL |
| Il catalogo come dato: aggiungere un tutorial = aggiungere una voce, home/cassetto/anteprime si aggiornano da sole | Le voci del catalogo SAUL |
| Modale per aprire il tutorial; richiesta di un tutorial come **opzione** (un indirizzo o un link configurabile nel kit) | La rotta `POST /api/contact/tutorial`, il destinatario, Brevo, i domini ammessi |
| Cattura delle scene da cartella locale o da URL (Playwright) e onboarding via MCP | Credenziali, utenti e dati di accesso al sito SAUL (mai nel repo Cueflow) |
| Esportazione MP4 (più avanti) | — |

Lo stile visivo scelto da Ballu (chiaro, "pay-TV", video senza bordi, velo chiaro sfocato con tasto play navy davanti al
video fermo) è il **tema di default della shell** di Cueflow, perché è il risultato che vogliamo ottenere ovunque. Quello
che è esplicitamente SAUL (colori, font, logo) è solo un tema.

Stile già **scartato** da Ballu, da non riproporre: dark mode, card stondate con cornici scure, elenchi standard,
modulo di richiesta in pagina, tutorial incorporato in pagina (si apre in modale), megamenu carico.

## Come lavora l'utente finale con Cueflow (obiettivo del piano)

1. Una persona (es. Ballu) crea una cartella di lavoro anche fuori dal progetto del sito e aggiunge il server:
   `claude mcp add cueflow -- npx cueflow mcp` (finché il pacchetto non è pubblicato: `npx` da repo git).
   Non esiste un "link" a un server ospitato: il server deve vedere i file locali e aprire un browser.
2. Il server MCP porta con sé il metodo (`instructions` all'avvio + un tool `guida_al_metodo`). Claude **come prima cosa
   chiede su quale sito lavorare**: cartella locale (all'inizio) o URL https (dopo).
3. Claude studia il sito (cattura scene, estrae tema), poi **discute con la persona** pubblico, tono, lingue, voce,
   regole di prodotto. Il risultato si salva nel kit in `brief.json`.
4. Scrive i tutorial con i tool esistenti (`add_step`, `preview_frame`, validazione).
5. Costruisce la guida (`build_site`), con lo stesso risultato che si vede oggi in `sol`.

## Passi (in ordine; uno alla volta, ognuno con test e commit)

Ogni passo: modifiche in Cueflow, `npm run typecheck && npm test` verdi, demo ricostruita e guardata in un browser vero
(Playwright), commit. **Non** chiudere un passo senza averlo visto girare: in questo progetto l'unica verifica che conta
è il browser.

### 0. Preparazione (Ballu)
- `git push` del branch `dev` di `sol` (o un `git bundle`) così Luca può vedere `docs/assets/*` e il player.
- Leggere `docs/assets/{tutorial.js o player, shell.css, cards.js, cards.css, catalogo}` e la memoria
  `sol_docs_video_tutorial.md`. Elencare i file in "generico / SAUL" usando la tabella sopra. Se un file è misto
  (es. un player con i selettori SAUL dentro), annotare come separarlo.
- Clonare Cueflow accanto a `sol` e lavorare su un branch (`feat/docs-shell`), non su `main`.

### 1. Player a pari del lavoro di Ballu
Confrontare `src/player/player.js` con il player di `sol` e portare in Cueflow ciò che manca: capitoli sulla barra,
velocità, sottotitoli/voce separati, `#passo-N`, tastiera, riduci-movimento, trascrizione, modale, velo di avvio e poster.
Mantenere ciò che Cueflow ha già: azioni `start/update/finish` idempotenti, `seek` per l'anteprima, camera, finestra
con regione. Nessuna dipendenza nuova: il player resta senza librerie.
Fatto quando: la demo di Cueflow ha gli stessi comandi del tutorial di `sol`.

### 2. Controlli di qualità nel validatore
In `validate.ts`: durata stimata/reale ≤ limite del kit (default 90 s), passi troppo lunghi (una/due frasi), selettori
che non esistono più, parole del dizionario di pronuncia non coperte. Messaggi come frasi leggibili che dicono al modello
come correggere (convenzione del progetto).

### 3. Voce
Completare `tts.ts`: istruzioni di stile e voce configurabili **nel kit** (non nel codice), dizionario di pronuncia dal
kit, voce per lingua, anteprima con voce del browser. Cache per impronta di testo+voce+modello+stile (già c'è per
testo/voce/lingua: aggiungere stile). Provare con una chiave vera e ascoltare. La sintesi vocale OpenAI è già verificata
una volta (8 mp3 della demo); la durata audio nel player no.
Decisione di Ballu da portare qui: il canale della voce per SAUL (FANTASTICO o chiave OpenAI diretta) **resta in `sol`**,
Cueflow supporta più provider tramite `TtsProvider`.

### 4. Tema e brief nel kit
Aggiungere al kit `theme.json` (token, font, logo, URL font opzionale) e `brief.json` (sito, pubblico, tono, lingue,
regole di prodotto in testo libero, dizionario di pronuncia, limiti, voce). Schemi zod in `schema.ts`, caricamento in
`kit.ts`. Il player e la shell leggono il tema; niente colore SAUL nel codice.

### 5. `build_site`: la guida completa
Nuovo output accanto a `build`: da kit a una cartella statica con home/catalogo, pagine di dettaglio, sidebar, PDF,
poster, modale. Il catalogo è un dato (`catalog.json` o dedotto dalle guide). Una pagina autosufficiente per guida,
senza build step per chi la apre. Partire dal risultato di `sol` e **riprodurlo con il tema SAUL** dal kit come prova.
Fatto quando: costruendo il kit SAUL con Cueflow si ottiene una guida indistinguibile dall'attuale (screenshot a
confronto sugli stessi viewport).

### 6. Onboarding via MCP
Nuovi tool: `init_kit`, `set_source` (cartella o URL), `get_brief`/`set_brief`, `guida_al_metodo`, `build_site`.
`instructions` del server con il metodo e l'ordine "prima chiedi su quale sito lavorare". Test con un client MCP vero,
come già fatto per gli altri tool.

### 7. Cattura delle scene
`capture_scenes` da cartella locale (HTML già pronto) e poi da URL: serializza il DOM con CSS inlinato e script
rimossi in `scenes/`, **solo dati finti**, ed estrae i token del tema. Login e dati sensibili: mai salvati nel kit; per
siti con accesso, chi usa lo strumento fornisce un ambiente di prova. Questo passo era già il punto 1 della roadmap.

### 8. Riportare `sol` a "solo specifico"
Dopo che Cueflow produce la guida SAUL:
- creare in `sol` una cartella kit (`docs/` o `docs-kit/`) con: `brief.json` (regole SAUL, tono, dizionario), `theme.json`,
  `scenes/` (clone UI con casi finti), `guides/`, `catalog` e i testi delle guide;
- eliminare da `sol` player, shell, CSS/JS di catalogo e script di narrazione, sostituiti da `npx cueflow build_site`;
- lasciare in `sol` un README breve: "come rigenerare la guida", dove stanno le regole SAUL, e **la regola di
  manutenzione** (chi cambia una schermata dell'app aggiorna il tutorial che la mostra, nello stesso lavoro);
- tenere in `sol` il backend delle richieste di tutorial e `deploy-docs`, che sono specifici.
Controllare con un diff che nessuna regola SAUL sia finita in Cueflow e nessun pezzo generico sia rimasto in `sol`.

## Da non fare
- Non incollare in Cueflow testi, colori, nomi o casi d'esempio di SAUL (nemmeno "come esempio": usate la demo).
- Non committare chiavi (`OPENAI_API_KEY` sta in `.env`, già ignorato) né dati reali di clienti.
- Non riscrivere in `sol` ciò che Cueflow già fa; se manca, si aggiunge a Cueflow.
- Non cambiare le decisioni del `CLAUDE.md` di Cueflow senza chiedere a Luca.

## Decisioni ancora aperte (non bloccano i passi 1-6)
- Dove si pubblica la guida di `sol` (saul-ai.it, dentro l'app, entrambi) e chi la mantiene: sono scelte di `sol`.
- Canale della voce per SAUL: FANTASTICO o chiave diretta (scelta di `sol`).
- Lingue: solo italiano all'inizio o inglese subito dopo il pilota. Cueflow supporta già più lingue per guida.
- Pacchetto npm `cueflow`: pubblicare quando i passi 1-6 sono fatti.
