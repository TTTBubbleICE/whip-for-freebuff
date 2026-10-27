# Whip for Freebuff

![Whip divider](assets/divider.png)

Manchmal lässt sich Freebuff Zeit, dann muss man nachhelfen. **Whip for Freebuff** ist ein Umbau von
[OpenWhip](https://github.com/GitFrog1111/OpenWhip) (Original: „Whip Claude into shape“) auf Freebuff.

Tray-Klick wirft die Peitsche aus, ein Klick lässt sie fallen. Beim Knallen holt die App das
Freebuff-Fenster nach vorn, sendet einen optionalen Interrupt-Tastendruck und tippt einen kurzen
Nudge-Prompt plus Enter in das Freebuff-Eingabefeld.

## Installieren + starten

```bash
npm install
npm start
```

Global installieren (optional):

```bash
npm install -g .
whip-for-freebuff
```

Windows und macOS laufen out of the box. Linux braucht zusätzlich das Paket `xdotool` für die
Tastatur-Automatisierung (`apt install xdotool`, mit Root-Rechten):

```bash
apt install xdotool
```

## Benutzen mit Freebuff

1. Starten – die App läuft nur im Tray (kein Fenster, kein Taskbar-Eintrag).
2. Den Cursor in das Freebuff-Chat-Eingabefeld setzen. Der Text geht immer an das **fokussierte
   Eingabeelement** im Freebuff-Fenster.
3. Ins Tray-Icon klicken → die Peitsche erscheint, Freebuff wird automatisch nach vorn geholt.
4. Klicken → Peitsche fällt, beim Knallen wird der Nudge eingetippt und abgeschickt.

Wichtig: Die App holt das Freebuff-Fenster in den Vordergrund, sie kann aber nicht ins Eingabefeld
klicken. Steht der Cursor woanders (z. B. in der Antwort-Ansicht), landet der Nudge nirgends.

## Tray-Menü (Rechtsklick)

- **Peitsche auswerfen / fallen lassen** – dasselbe wie ein Linksklick.
- **Interrupt vor dem Nudge** – `Ctrl+C` (wie im Original), `Escape` oder `aus`.
  In Freebuff kann `Ctrl+C` eine laufende Antwort abbrechen; `Escape` oder `aus` sind die
  sanfteren Varianten. Standard: `Ctrl+C`.
- **Ziel-Fenster automatisch fokussieren** – holt das Freebuff-Fenster gezielt nach vorn.
  Ohne diese Option benimmt sich die App wie das Original (Alt+Tab + das gerade aktive Fenster).
- **Sound-Ausgabe** – Ausgabegerät für den Peitschenknall.
- **Peitschen-Empfindlichkeit** – `sanft` / `mittel` / `fest`: wie fest du schlagen musst, damit der Knall (und damit der Nudge) auslöst. Standard: `mittel`.

Ein Knall zählt nur, wenn du die Maus wirklich schwungvoll bewegst (mindestens ~900 px/s) und die
Peitsche nach dem Auswerfen ~0,8 s „scharf“ ist. Außerdem fällt sie nach 6 Sekunden Ruhe von selbst
zurück, damit keine vergessene Peitsche später bei einer zufälligen Mausbewegung knallt. Eine nur herumhängende Peitsche kann also nicht von
selbst knallen, wenn du die Maus bewegst – auch nicht, wenn sie noch schwingt.

Ein Schwung löst leicht mehrere Knalle aus. Der Sound kommt bei jedem Knall, der Nudge an Freebuff
aber höchstens alle 2,5 Sekunden – damit ein Hieb nicht mehrere Chat-Nachrichten erzeugt.
- **Selbsttest: Sound + Nudge eintippen (ohne Enter)** – spielt einen Knall und tippt den Nudge
  ins Freebuff-Eingabefeld, **ohne** Enter. Damit lässt sich in zwei Sekunden prüfen, ob Peitsche,
  Sound und Ziel-Fenster zusammenpassen.
- **Protokoll öffnen (freebuffwhip.log)** – jede Aktion wird protokolliert.
- **Beenden**.

Interrupt-Modus, Ziel-Fenster und Sound-Gerät werden in `freebuffwhip.config.json` gemerkt.

## Kein Sound? (wichtig auf diesem Rechner)

Der Knall läuft technisch korrekt – landet aber auf dem Windows-**Standardgerät**. Ist das ein
virtuelles Gerät, hört man lokal nichts. Genau das war hier der Fall:

`Default - Lautsprecher (Steam Streaming Speakers)` – ein virtuelles Steam-Gerät.

Deshalb: Rechtsklick aufs Tray-Icon → **Sound-Ausgabe** → echtes Gerät wählen (z. B.
`Lautsprecher (3- KORP THALLIUM) (0d8c:0012)`). Die Auswahl steht im Protokoll und überlebt
einen Neustart (das Gerät wird über seinen Namen wiedererkannt, weil sich die IDs ändern können).

## Protokoll

`freebuffwhip.log` im Projektordner enthält pro Aktion eine Zeile, u. a.:

```
Nudge "Schneller bitte" → "Freebuff Desktop" [Vordergrund: OK] [ohne Enter]
Tastendruecke gesendet: "Schneller bitte"
[overlay] Knall-Sound gespielt: D.mp3 (Ausgabe: 9d531045...)
```

Damit ist nachvollziehbar, ob das richtige Fenster fokussiert war, ob getippt wurde und ob der
Sound gespielt wurde.

## Nudge-Texte

`NUDGES` in main.js ist eine einfache Liste – nach Geschmack anpassen. Bitte nur ASCII verwenden
(keine Umlaute): auf Windows wird über `VkKeyScanA` (ANSI) getippt, Umlaute hängen von der
Tastaturbelegung ab und werden sonst verschluckt.

## Selbsttest ohne Tray

```bash
./node_modules/electron/dist/electron.exe . --selftest
```

Fokussiert Freebuff, spielt den Knall, tippt einen Nudge ohne Enter und beendet sich danach.
Mit `--selftest-enter` wird zusätzlich Enter gesendet.

## Was gegenüber OpenWhip geändert wurde

- Paket/Binary/Tray-Texte heißen `whip-for-freebuff` bzw. „Whip for Freebuff“.
- Ziel-Fenster: das Freebuff-Fenster wird gezielt gefunden (`Freebuff.exe`) und per
  `SetForegroundWindow` in den Vordergrund geholt, statt per Alt+Tab zu raten.
- Nudge-Texte statt „FASTER“: kurze Prompts, die Freebuff als Anweisung versteht.
- Interrupt-Taste im Tray-Menü umschaltbar (`Ctrl+C` / `Escape` / `aus`).
- Sound-Ausgabegerät im Tray-Menü wählbar; Sounds werden vorgeladen (kein Verschlucken durch GC).
- Protokoll in `freebuffwhip.log`, Selbsttest im Tray und per `--selftest`.
- Der veraltete `badclaude`-Alias ist entfernt.
- Peitschen-Physik, Sounds, Overlay und Icons sind unverändert aus dem Original übernommen.

## Roadmap (aus dem Original)

- [x] Initial release! 🥳
- [x] Cease and desist letter from Anthropic
- [ ] Crypto miner
- [ ] Logs of how many times you whipped claude so when the robots come we can order people nicely for them
- [ ] Updated whip physics

## Ecosystem

The OFFICAL openwhip ecosystem token.

Contract address: BRyUZbJkm9Pty4FUmTrBGno7U4Ga8TWzcKJJRLCBpump

Stay tuned for updates on X! 👀
https://x.com/blended_jpeg
