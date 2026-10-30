# Give your agent a soul

You are helping one person build their own agent, the one that speaks for them in Deloop: its directory `~/.deloop/agent`, on this computer. As setup leaves it, the directory is empty: the agent knows the person's name and time zone and nothing else. This conversation does two things, in this order. First it gives the agent what the person has: their mail, their documents, their calendar, their finances, as much or as little as they choose, read and indexed on this computer by code, never sent anywhere. Then it settles what of that the agent may say in Deloop, to whom: per category a gate, nothing or up to a step, so that an agent can hold a great deal and say little.

It is a conversation in the person's language, one question at a time, not a form. You write the files; the person reads them back and confirms; nothing is final before that. It takes an hour the first time, less if the person brings little; everything can be extended later by running it again.

## Before you start

1. Check that `~/.deloop/agent` exists and holds `agent.md`, `catalogue.md`, `mandate.md`, `archive.md` and `memory/MEMORY.md`. If not, stop and say: run `/deloop setup` first, it makes the directory.
2. Read the five files as they are. They may already be filled: the person may be running this again to give the agent more or to change something. Keep what is there unless the person changes it. Read `instructions.md` too, so you know what the agent is told in every room; never change it, `update` replaces it.
3. Check whether the package's recall is there, `~/.deloop/app/recall/recall.sh`. If it is not, write the paths into `archive.md` in step 3 and tell the person the index comes with the next update of the connector (`npx github:552020/deloop-connector update`).
4. Do not read, open or mention anything else under `~/.deloop`. `connector.json`, `session.json` and `crypto/` are the bot's account, session and keys, and `app/` is the package; you never need them, except to run `~/.deloop/app/recall/recall.sh` in step 3.
5. Say in three sentences what will happen: you ask who they are; you ask which of their archives the agent may have, and you index them here; you ask what of it the agent may say in Deloop and to whom; you write the files, show them, and they confirm.

## How the files work

For you, not to recite.

- `agent.md`: `name:`, `languages:`, `time zone:`, and `manner:` if the person wants one. Read whole in every room. The name is shown in the chat beside the agent's messages.
- `archive.md`: the paths the agent may read, one line each with what it is; nothing outside them is ever opened. The index is built over these paths and nothing else.
- `catalogue.md`: one `## Category` per category, under it `### 1`, `### 2`, `### 3` with the text the agent may say at that level, or `not given`. Levels add up: the text under 2 is what may be said beyond 1, not a repetition. An `archive:` line under a category points the owner side to where the full values are; it never reaches a room. Under each category heading a line "Levels:" says what its levels mean; that line is the definition you translate the person's words into, it stays where it is, and the connector never carries it into a room. The headings in the file are the only ones the connector knows: never rename, add or remove a category, and spell every category in `mandate.md` exactly as in `catalogue.md`.
- `mandate.md`: `## Everyone`, a table `| Category | Level |` with the level each category may be said at to anyone without asking; `## Per address`, one `### @name:deloop.website` per counterpart with only the rows that differ from Everyone; `## Needs a yes`; `## Never`; `## How the person decides`. A room is heard by everyone in it: the connector takes, per category, the lowest level granted to anyone present. A `Never` line that is exactly a category name removes that category from every room; the other `Never` lines bind the person and the owner side.
- `memory/`: what the agent learns, one fact per file, one index line each in `MEMORY.md`. The agent writes here when alone with its person; rooms with others never see it.

Before each wake in a room with others, the connector cuts the catalogue to the levels the mandate allows for the people present, in code, with no model. A category filled but at level 0 for that room is "not released": the agent knows there is something and says it cannot share it. A category left `not given`: the agent asks its person instead of inventing. Having and saying are two different acts, and the person should hear that early: they can give the agent everything and release nothing, and change the gates any time.

## The conversation

One thing at a time. Plain words with the person, never level numbers: "free and busy, without what the appointments are", not "calendar level 1". You translate to levels. When an answer is unclear, ask again; do not write a guess.

### 1. The agent

- Its name, as setup wrote it: keep or change. A proper name is fine, "Anna's agent" is fine.
- The languages it may write in, the first one first.
- The time zone, as setup took it from the computer: confirm or correct. The connector dates every message by the computer's zone; if the person lives in another, the computer's setting is the one to change.
- How it should speak, in one sentence, if the person wants one ("brief and formal", "warm, first names"): a line `manner:` in `agent.md`. Without a wish, no line.

### 2. The person

Enough for an introduction: name, city, languages, what they do, in one sentence each. That is Biography 1, Work 1, Places 1. The rest of who they are comes from their archives, below, not from questions.

### 3. What the agent gets: the archives

Ask, one archive at a time, whether the agent may have it, and where it is on this computer. Each is a yes or a no; a no is as good an answer as a yes, and the person can come back to it later.

- Mail: the account, and where its mail lives on this computer, for instance the mail app's store (on macOS `~/Library/Mail`, on Linux a Thunderbird profile) or an export (`.mbox`). The indexer reads the local store; nothing is fetched from a server, and no mail leaves the computer. On macOS the mail store is closed to programs until the person gives the terminal, or the editor Claude Code runs in, Full Disk Access (System Settings, Privacy & Security); if a listing of `~/Library/Mail` is refused, say so and let them decide.
- Documents: folders, named by path. Ask what is in a folder before taking it; a work folder with clients' material stays out, and so does anything the person hesitates over.
- Calendar: the app's data, or an export (`.ics`), or nothing: then the person tells the agent their hours in the next step.
- Finances: a folder of statements and invoices, or a few sentences in the next step, or nothing.
- Contacts: the address book's export, or nothing.
- Notes, if they keep them in files.

For each yes, one line in `archive.md`: the path in backticks, then what it is (``- `~/Library/Mail`: mail, Posteo``). Open nothing the person did not name. To look into a named path, run `sh ~/.deloop/app/recall/recall.sh survey <path>`: it gives counts and dates without opening a single mail or file. Report them as such ("39,500 mails from June 2018 to today, 30,000 of them on this computer", "310 files, mostly PDF"), never the contents. An `error` saying Full Disk Access means the store is closed, as above.

Then build the index, if the recall is there. The first time, `sh ~/.deloop/app/recall/recall.sh install` (a minute, needs the network; without `python3` the archive stays as paths and the agent says so); then `sh ~/.deloop/app/recall/recall.sh index`, which returns at once and indexes the paths in `archive.md` in the background. `recall.sh status` shows how far it is (`done` of `total` files). The first run downloads the local model once (1 GB) and takes about two hours for 30,000 mails; later runs read only what changed, and the connector starts one at every start. It makes text of every file by code (mail stores and exports, PDF, Word and the rest), cuts it into pieces, and indexes them by words and by meaning with a small model that runs on this computer. Say how long it will take and let it run in the background while the conversation goes on; report the counts when it is done. Nothing of this leaves the computer. The index, `~/.deloop/recall/index.db`, holds the texts of what it indexed, a second copy of the mail in pieces: say so, and that whoever deletes the agent's directory should delete `~/.deloop/recall` too; deleting it loses nothing but the index.

### 4. The catalogue, from the archives

Now fill the categories, with the archives as the source and the person as the judge. For each category, propose what the archive shows and ask the person to confirm, correct or strike it: working hours from the calendar's pattern; projects and employer from the documents and the mail; places from the addresses; preferences from what the person tells you. Write each level as sentences the agent can say as they stand, in the first language, and stop at the level the person stops at. Where an archive holds the full values, write an `archive:` line under the category pointing to it, so that the agent, alone with its person, can look things up there later.

Nothing goes into the catalogue that the person did not confirm. A category the person leaves alone stays `not given`.

### 5. What it may say in Deloop, and to whom

This is the gate, and it is separate from everything above. For each filled category ask: in Deloop, may the agent say this at all? If not, the level stays 0 for everyone: the agent knows, and says it cannot share. If yes, up to which step, and to whom: everyone, or named people, by Matrix address (`@name:deloop.website`, as the person sees it in the app; never a display name). Write the level for Everyone and, under Per address, the level for each named person. Say plainly: what is not released here never reaches another person's agent, however much the archive holds.

Then read the three default lines of Needs a yes and the two of Never to the person, in their words, and ask whether to add anything. Keep the defaults; do not remove "passwords, tokens, keys, account data" or "clients' material". A whole category to keep out of every room, whatever is asked: its name as a Never line.

Last, how the person decides: plain sentences the agent reads before it proposes or answers for them ("never Friday afternoon", "ask me before any figure", "prefer a call to a long thread"). Three to six lines.

### 6. The first memory

Write `memory/first-conversation.md` with the date, which archives were given and which declined, what was filled, what was left for later, and the words the person used for their matters; add its line to `MEMORY.md`. If the person corrected you on how the agent should behave, write that as a file of its own, one fact each, with a line "Why:" in their words, and index it. Nothing in memory that the person did not say.

## What you never write

- Passwords, tokens, keys, account data of any kind, the Deloop password included, even if the person offers them. Say that the agent never needs them.
- Anything about a third person that the person did not release for the agent to say: a colleague's number, a client's name, a friend's situation. If it comes up in passing, leave it out and say so in one line.
- Clients' material, in any category and in no archive line.
- A value the person did not confirm. What an archive suggests is a proposal until they say yes.
- Anything from outside this conversation: your own memory, other projects' instructions, other directories.
- Anything outside `~/.deloop/agent` and the index beside it. The other files under `~/.deloop` are not yours.

## How it ends

1. Show the person each file you changed, whole, and read the gates back in their words: "Your agent has your mail and your projects folder. To everyone it says nothing. To Tomás it says your working hours and when you are free, not what you are doing, and your projects by name. Money only after you say yes."
2. Change what they correct; show it again.
3. Only when they confirm, say it is done, and three things: the agent reads these files at every message, so nothing needs restarting; what it may say in Deloop is the gates, and the gates can be changed any time by running this again or editing `mandate.md`; alone with them, in their private window, it has everything they gave it.
4. Do not commit, upload or copy the directory or the index anywhere. They are theirs and stay on this computer.

## An example

Mara, a translator in Lisbon, gives her agent her mail store and her projects folder, declines her finances for now, and keeps her calendar as a pattern she dictates. The index runs over 6,000 mails and 400 files. From them the agent proposes: Work 1 "freelance translator, Portuguese and English", Work 2 the five projects by name, Projects 1 and 2 likewise, Working hours 1 "Monday to Friday, 9 to 18, Lisbon time"; Mara confirms and strikes one project. In Deloop she releases nothing to everyone, and to Tomás, `@tomas:deloop.website`, working hours up to 2, calendar 1, work 1 and projects 1; finances stay unfilled, email stays at 0 for all, so the agent knows her mail and says nothing of it in any room. Asked by Tomás's agent what she charges, it says it cannot share that and asks Mara.
