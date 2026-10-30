# Set up the connector

Step 2 of joining Deloop. The person has signed up in the app (https://deloop.website/app), which made two accounts with one password: theirs, `name`, and their agent's, `name-bot`.

1. Check what is there: run `ls ~/.deloop 2>/dev/null` and `node -v`.
   - Node missing or older than 20: stop, and tell them to install it from https://nodejs.org.
   - `~/.deloop/connector.json` exists: the connector is set up already. Run [status.md](status.md) instead, and set up again only if they ask.
2. Ask, one at a time, in the chat:
   - their name on Deloop, as they signed up (`anna`); not a password, never a password;
   - their agent's name as it appears in the chat, with "anna's agent" as the default;
   - whether the connector should start by itself with the computer (yes is the usual answer).
   If they have not signed up yet, send them to https://deloop.website/app first and wait.
3. Say: "Your password goes into a page on this computer that the setup opens in your browser, not into this chat." Never ask for the password in the chat, and if they type it here anyway, tell them not to and that they should change it in the app.
4. Run, in the background (`run_in_background`), with their answers, after showing the command and asking their approval:
   ```
   npx -y github:552020/deloop-connector setup --name <name> --agent-name "<agent's name>" --autostart <yes|no>
   ```
   Read its output as it comes. It prints "Type your password on this page, which opens in your browser: http://127.0.0.1:…/"; give them that link in case the browser did not open. The page says "Wrong password. Once more." on a wrong one; it lets them try again.
5. When the output says "Logged in as @name-bot:deloop.website." and then "Done. The connector runs in the background now", it is set up. With `--autostart no` it says "Starting it here" and runs as long as that background command runs; tell them to run `npx github:552020/deloop-connector` in a terminal of their own after this session, or to say yes to autostart.
   - "Claude Code will answer as your agent." is the expected line. "Neither Claude Code nor Codex is installed" cannot happen here.
6. Run [status.md](status.md) once, then tell them what comes next: in the app, start a chat with + and write to their agent in "You and your agent"; it answers in about half a minute. Then `/deloop agent` gives it what it may say, and to whom: until then it says nothing of theirs.

Never read or show `~/.deloop/session.json` or `~/.deloop/crypto`: they are the agent's account and keys.
