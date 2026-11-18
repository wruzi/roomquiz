# Roomquiz

Minimal live classroom quiz. The host creates a room, students join from their phones with a QR code or a 6-character code, and answers show up live.

## Run

```bash
npm install
npm start
```

Open `http://localhost:3000` on the host computer and tap **Host → Create Room**.
Students' phones must be on the **same Wi-Fi**. The QR code automatically uses the computer's LAN address (e.g. `http://192.168.x.x:3000/?room=ABC123`).

- Different port: `PORT=8080 npm start`
- Hosting behind a tunnel or domain: `PUBLIC_URL=https://quiz.example.com npm start` (QR codes will use this URL)
- Windows may ask to allow Node through the firewall the first time. Allow it on private networks, or phones won't be able to connect.

## Features

- **Host**: create a room → QR + code (full-screen "present" view for a projector)
- Questions with 2–4 **options** (mark the correct one beforehand) or **text** answers (optional accepted answers; you can also mark answers correct afterwards)
- **Timer slider**, 10–60 s; the question also ends early once everyone has answered
- **Prepare the next question while one is live**: it's queued as "Up next" and starts 5 s after time is up. You can Edit, Remove, Hold, or Send Now
- Live **answer distribution chart**, answered count, average time, **top 3 quickest**
- Student list with live status and each student's answer
- **Scoring**: 10 pts per correct answer. Ranking = score, then total time spent on correct answers (faster ranks higher)
- Students see correct/incorrect, their position, their rank, and the top 5
- Light/dark **theme switcher**; reloading the page restores the session for both host and students

State is kept in memory: restarting the server clears all rooms.
