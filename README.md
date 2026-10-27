<p align="center"><img src="docs/icon.png" width="128" alt="UrSim"></p>

<h1 align="center">UrSim</h1>

<p align="center">A <i>FIRST</i> Tech Challenge simulator for the 2026–2027 season, <b>BIOBUZZ</b>, made by FTC team <b>URAN92</b></p>

<p align="center"><a href="../../releases/latest"><b>⬇ Download the latest version</b></a> · <a href="https://ursim.onrender.com">Play in the browser</a> · <a href="README.ru.md">Русский</a></p>

![Main menu](docs/menu.jpg)

Drive **URAN V1**, a real competition robot built from its team's CAD (mecanum drive, auto-aiming turret, intake and flywheel shooter), around the BIOBUZZ field. Collect POLLEN and NECTAR, launch them into your HIVE to tip it, and play full **2:30 matches** with live scoring and an automatic referee, or practice without a clock. Play **online 2 vs 2** with friends: up to four players join a room with a 4-letter code. Every robot has its own **top 100 high score** table.

![In game](docs/game.jpg)

## Download

Every version is on the [Releases](../../releases) page. Pick the zip for your computer:

| System | File |
|---|---|
| Windows 10 / 11 (64-bit) | `UrSim_<version>_Windows.zip` |
| macOS 12 or newer (Intel and Apple Silicon) | `UrSim_<version>_Mac.zip` |
| Linux (64-bit) | `UrSim_<version>_Linux.zip` |

No install needed to play in the browser: **https://ursim.onrender.com** (Chrome, Edge, Firefox or Safari). The app and the website share the same online server, so they can play together.

## How to start

**Windows.** Unzip the archive (right-click → *Extract All*) and run `UrSim.exe`. If you see *"Windows protected your PC"*, click *More info* → *Run anyway*: the game is not signed with a paid Microsoft certificate.

**macOS.** Unzip the archive and drag `UrSim` into *Applications*. The first time, right-click `UrSim` → *Open* → *Open* (the game is not signed by Apple). If macOS says the app *"is damaged"* or *"cannot be verified"*, open Terminal and run:

```bash
xattr -cr /Applications/UrSim.app
```

**Linux.** Unzip the archive and run `./ursim` from the unzipped folder. If it closes right away with a sandbox error (happens on Ubuntu 24.04 and newer), run this once in that folder:

```bash
sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox
```

Press `F11` for fullscreen.

## Controls

PS4, PS5 and Logitech F310 gamepads (the same ones allowed on an FTC Driver Station), or the keyboard. Any button and any key can be changed in **Settings → Controls**.

| Action | PS4 / PS5 | Logitech F310 | Keyboard |
|---|---|---|---|
| Drive and strafe | left stick | left stick | W A S D |
| Turn | right stick | right stick | Q / E |
| Intake (hold) | L1 | LB | F |
| Eject balls (hold) | ↓ | ↓ | K |
| Shooter on / off | L2 / R2 | LT / RT | Z / V |
| Transfer into the shooter (hold) | R1 | RB | Space |
| Pause | PS | Logitech | Esc |

The turret aims at the top cell of your HIVE and sets the flywheel speed by itself. Shoot from the side the cell's opening faces (after a tip, from the other side).

## Game rules

In matches an automatic referee calls the BIOBUZZ game rules it can judge (G402, G405, G408, G410, G417, G421): MINOR FOULS give the opponent 5 points, MAJOR FOULS 20, and a second yellow card becomes a red card. Fouls, cards and the robot battery (voltage sag that slows the robot) can each be turned off in **Settings → Rules**.

## If it runs slowly

Go to **Settings → Graphics**, set quality to *Low* and turn shadows off. *Auto* quality lowers the resolution and effects by itself when the frame rate drops below 50. A graphics card with WebGL 2 support is needed (nearly any made since 2015), plus an internet connection for online play.

## Language

The in-game interface is in Russian for now.

---

Unofficial fan project, not affiliated with *FIRST*®. *FIRST*®, *FIRST*® Tech Challenge and BIOBUZZ™ are trademarks of *FIRST*.
