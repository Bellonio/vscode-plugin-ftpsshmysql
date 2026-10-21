# WebSpace Manager

Estensione VSCode per gestire spazi web: file via SFTP/FTP, terminale SSH, MySQL e telemetria del server. Le credenziali sono sempre cifrate.

## Funzioni
- **Spazi**: ogni spazio raggruppa l'accesso ai file (SFTP o FTP, con root path), il terminale SSH, il database MySQL (diretto o tramite tunnel SSH) e la telemetria.
- **Nessuna connessione accidentale**: un click su uno spazio lo seleziona e basta. Ci si connette solo espandendo "File"/"DB" o aprendo Terminale/Telemetria.
- **Ordinamento**: il pulsante nella barra della vista alterna A-Z e ordine manuale. In manuale si usano le frecce su/giù accanto allo spazio, Alt+↑/↓ o il menu "Sposta in cima/in fondo". "Fissa in cima" funziona in entrambe le modalità.
- **File**: apri e salva direttamente sul server. Dal menu contestuale: nuovo file/cartella, rinomina (F2), elimina (Canc, con conferma), carica file/cartelle, scarica, copia path, terminale qui.
- **File aperti al riavvio**: le schede dei file remoti restano aperte e si possono modificare **senza connettersi e senza chiedere password**. La connessione (con superpassword) si apre solo al salvataggio (Ctrl+S). Se nel frattempo il file è cambiato sul server, prima di sovrascriverlo viene chiesta conferma. La copia locale serve solo a questo e viene cancellata quando chiudi la scheda.
- **FTPS**: l'opzione "Accetta certificato non valido" serve per hosting propri con certificato self-signed o intestato al provider.
- **Upload drag&drop**: trascina file o cartelle da Esplora risorse o dall'Explorer di VSCode su una cartella remota. I nodi remoti non si possono trascinare, quindi non c'è modo di spostare per errore una cartella dentro un'altra.
- **Ricerca** (lente o Ctrl+Alt+F): spazi e file/cartelle **già caricati** nell'albero. Non interroga mai il server.
- **MySQL**: esplora database e tabelle, "Nuova query" e Ctrl+Enter per eseguire.
- **Telemetria**: CPU, RAM, load, uptime, dischi/quota, processi top, stato MySQL.
  - Prima esegue un solo comando di rilevamento. Se il server non permette l'esecuzione di comandi (account solo SFTP, shell limitata) lo dice subito e non ci riprova più.
  - Il campionamento usa la connessione SSH già aperta e gira solo con il pannello visibile. Al primo errore si ferma.

## Sicurezza
- Password, chiavi private e passphrase sono cifrate con AES-256-GCM, con chiave derivata dalla **superpassword** tramite scrypt. In chiaro non viene salvato nulla.
- La superpassword viene chiesta **a ogni connessione** di uno spazio e non viene mai memorizzata. Le credenziali decifrate restano in memoria solo finché lo spazio è connesso: "Disconnetti" le cancella.
- Una superpassword errata viene riconosciuta in locale, prima di contattare il server. Non si generano login falliti, quindi niente ban (fail2ban).
- Gli accessi falliti sul server non vengono mai ritentati in automatico.
- La chiave del server SSH viene verificata (trust on first use). Se cambia, compare un avviso bloccante.
- La chiave privata SSH viene importata (cifrata) dentro lo spazio, quindi l'export funziona anche su un altro PC/OS.
- **Export/Import** (menu "..." della vista): il file `.wsm.json` contiene le credenziali **cifrate** con la superpassword. Per importarlo serve la superpassword usata all'export.

> **Attenzione: se dimentichi la superpassword le credenziali non sono recuperabili.** Con "Reset vault" cancelli tutte le credenziali e tieni gli spazi, poi le reinserisci.

## Sviluppo
```
npm install
npm run build      # bundle in dist/
npm test           # unit test (vault, ordinamento, parser telemetria)
npm run package    # crea il .vsix (Windows e Linux, dipendenze solo JS)
```
F5 in VSCode avvia l'Extension Development Host.
Installazione: `code --install-extension webspace-manager-0.1.0.vsix`.
