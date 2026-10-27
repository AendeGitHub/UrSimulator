// Interface language: Russian or English, picked in Settings → Language. Both tables have the
// same keys. FTC terms (POLLEN, NECTAR, HIVE, FLOWER, GARDEN, AUTO, TELEOP, MAJOR FOUL, …) stay as
// they are in the game manual in both languages.
//
// Static texts are made with ht() and refreshed by localize() when a screen is shown again;
// texts that are built on every render just call t().

import { h, type Props } from './dom';

export type Language = 'ru' | 'en';
export const LANGUAGES: Language[] = ['ru', 'en'];
/** Each language in its own words, so it can be found whatever the current one is. */
export const LANGUAGE_NAMES: Record<Language, string> = { ru: 'Русский', en: 'English' };

const ru = {
  'common.back': 'Назад',
  'common.backArrow': '← Назад',
  'common.on': 'Вкл',
  'common.off': 'Выкл',
  'common.player': 'Игрок',
  'common.namePlaceholder': 'Например: Max',

  'loading.field': 'Загрузка поля BIOBUZZ…',
  'loading.failed': 'Не удалось загрузить игру. Подробности в консоли (F12).',
  'arena.subtitle': 'Симулятор FIRST Tech Challenge',

  'menu.play': 'Играть',
  'menu.records': 'Рекорды',
  'menu.settings': 'Настройки',
  'menu.match': 'Матч 2:30',
  'menu.practice': 'Тренировка',
  'menu.legal': 'Неофициальный фанатский симулятор. Не связан с FIRST®. BIOBUZZ™ — товарный знак FIRST.',
  'menu.noPad': 'Геймпад не найден — нажми любую кнопку на геймпаде или играй с клавиатуры',
  'menu.unsupportedPad': 'Есть неподдерживаемый геймпад. Подходят только PS4, PS5 и Logitech F310.',

  'pause.title': 'Пауза',
  'pause.resume': 'Продолжить',
  'pause.restart': 'Начать заново',
  'pause.toMenu': 'В главное меню',

  'settings.tab.controls': 'Управление',
  'settings.tab.graphics': 'Графика',
  'settings.tab.rules': 'Правила',
  'settings.tab.language': 'Язык',
  'settings.gamepads': 'Геймпады →',
  'settings.action': 'Действие',
  'settings.gamepad': 'Геймпад',
  'settings.pressButton': 'Нажми кнопку…',
  'settings.pressKey': 'Нажми клавишу…',
  'settings.controlsNote': 'Нажми на кнопку в таблице, потом нужную кнопку геймпада или клавишу (Esc — отмена). Если она уже занята, действия поменяются местами. С двумя геймпадами у gamepad2 свой робот и своя половина экрана, а в режиме «Оператор (FTC)» механизмы робота слушаются обоих геймпадов, как в FTC. R на клавиатуре — начать заново.',
  'settings.resetControls': 'Сбросить управление',
  'settings.quality': 'Качество',
  'settings.quality.auto': 'Авто (по FPS)',
  'settings.quality.high': 'Высокое',
  'settings.quality.medium': 'Среднее',
  'settings.quality.low': 'Низкое',
  'settings.shadows': 'Тени',
  'settings.outlines': 'Чёрные контуры',
  'settings.antialias': 'Сглаживание',
  'settings.driveSensitivity': 'Чувствительность езды',
  'settings.turnSensitivity': 'Чувствительность поворота',
  'settings.fps': 'Счётчик FPS',
  'settings.graphicsNote': '«Авто» само снижает разрешение и затенение, если FPS падает ниже 50, и возвращает, когда запас есть. Если игра тормозит, выключи тени и поставь «Низкое».',
  'settings.fouls': 'Фолы (очки сопернику)',
  'settings.cards': 'Предупреждения и карточки',
  'settings.battery': 'Аккумулятор (садится, робот медленнее)',
  'settings.rule.G402': 'В AUTO не трогать мячи и робота соперника на его половине — MAJOR FOUL',
  'settings.rule.G405': 'Не выбрасывать мячи за поле (промах при броске не считается) — MAJOR FOUL за мяч',
  'settings.rule.G408': 'Не брать NECTAR соперника — предупреждение, затем жёлтая карточка',
  'settings.rule.G410': 'NECTAR в цветок только в последнюю минуту — MAJOR FOUL за NECTAR',
  'settings.rule.G417': 'Не таранить раму улья — предупреждение, затем MAJOR FOUL и жёлтая',
  'settings.rule.G421': 'Не прижимать соперника дольше 3 с — MAJOR FOUL и ещё один каждые 3 с',
  'settings.rulesNote': 'Судья работает в «Матч 2:30». MINOR FOUL — 5 очков сопернику, MAJOR — 20; вторая жёлтая карточка становится красной: 0 очков за матч.',
  'settings.language': 'Язык интерфейса',
  'settings.languageNote': 'Термины FTC — POLLEN, NECTAR, HIVE, AUTO, TELEOP, MAJOR FOUL и другие — остаются как в руководстве по игре.',

  'action.forward': 'Ехать вперёд',
  'action.backward': 'Ехать назад',
  'action.left': 'Влево (стрейф)',
  'action.right': 'Вправо (стрейф)',
  'action.turnLeft': 'Поворот влево',
  'action.turnRight': 'Поворот вправо',
  'action.intake': 'Интейк: забрать мячи (держать)',
  'action.eject': 'Выкинуть мячи (держать)',
  'action.transfer': 'Трансфер в шутер (держать)',
  'action.shooterOn': 'Шутер включить',
  'action.shooterOff': 'Шутер выключить',
  'action.armUp': 'Flower Mode выключить (рука вверх)',
  'action.armDown': 'Flower Mode включить: брать из FLOWER',
  'action.slow': 'Медленный режим',
  'action.fieldCentric': 'Field-centric ↔ Robot-centric',
  'action.imuReset': 'Сброс курса (IMU)',
  'action.camera': 'Камера «За роботом»: вперёд / назад',
  'action.pause': 'Пауза',

  'camera.driver': 'Вид водителя',
  'camera.audience': 'Вид зрителей',
  'camera.follow': 'За роботом',

  'pad.keyboard': 'Клавиатура',
  'pad.unsupported': 'Неподдерживаемый геймпад',
  'pad.connected': 'Подключён {model} → gamepad{n}',
  'pad.disconnected': 'gamepad1 отключён — управление с клавиатуры',
  'pad.disconnected2': 'gamepad2 отключён',

  'label.touchpad': 'Тачпад',
  'label.leftStick': 'Левый стик',
  'label.rightStick': 'Правый стик',

  'control.a': 'a (✕ / A)',
  'control.b': 'b (○ / B)',
  'control.x': 'x (□ / X)',
  'control.y': 'y (△ / Y)',
  'control.dpad_up': 'крестовина вверх',
  'control.dpad_down': 'крестовина вниз',
  'control.dpad_left': 'крестовина влево',
  'control.dpad_right': 'крестовина вправо',
  'control.left_bumper': 'левый бампер (L1 / LB)',
  'control.right_bumper': 'правый бампер (R1 / RB)',
  'control.left_trigger': 'левый триггер (L2 / LT)',
  'control.right_trigger': 'правый триггер (R2 / RT)',
  'control.left_stick_x': 'левый стик ВПРАВО',
  'control.left_stick_y': 'левый стик ВВЕРХ',
  'control.right_stick_x': 'правый стик ВПРАВО',
  'control.right_stick_y': 'правый стик ВВЕРХ',
  'control.left_stick_button': 'нажатие левого стика (L3)',
  'control.right_stick_button': 'нажатие правого стика (R3)',
  'control.back': 'Share / Create / Back',
  'control.start': 'Options / Start',
  'control.guide': 'PS / Logitech',
  'control.touchpad': 'тачпад (только PlayStation)',

  'pads.title': 'Геймпады',
  'pads.about': 'Поддерживаются PS4 DualShock 4, PS5 DualSense и Logitech F310 — как на FTC Driver Station. У F310 сзади есть переключатель: «X» на Windows, «D» на Mac.',
  'pads.none': 'Не подключён',
  'pads.ready': 'Готов',
  'pads.readyCustom': 'Готов · свои настройки кнопок',
  'pads.needsSetup': 'Нужно настроить кнопки',
  'pads.setup': 'Настроить кнопки',
  'pads.reset': 'Сбросить',
  'pads.swap': 'Поменять gamepad1 ↔ gamepad2',
  'pads.unsupported': 'Не поддерживается: {id}',
  'pads.testerHint': 'Подключи геймпад и нажми любую кнопку — здесь появится проверка кнопок.',
  'pads.tester': 'Проверка: gamepad{n}',
  'pads.step': '{model} · шаг {step} из {count}',
  'pads.move': 'Отклони ',
  'pads.press': 'Нажми ',
  'pads.wizardNote': 'Пока идёт настройка, геймпад не управляет меню — используй мышь или клавиатуру.',
  'pads.skip': 'Пропустить',
  'pads.cancel': 'Отмена',

  'select.title': 'Настройки матча',
  'select.alliance': 'Альянс',
  'select.camera': 'Камера',
  'select.drive': 'Управление',
  'select.name': 'Имя',
  'select.namePlaceholder': 'Для рекордов',
  'select.robots': 'Роботы',
  'select.red': 'Красный',
  'select.blue': 'Синий',
  'select.pad2': 'gamepad2',
  'select.pad2Robot': 'Свой робот',
  'select.pad2Operator': 'Оператор (FTC)',
  'select.robot2': 'Робот gamepad2',
  'select.alliance2': 'Альянс gamepad2',
  'select.splitNote': 'два игрока, экран пополам',
  'select.start': 'Старт',
  'robot.rapidFire': 'Рапид-файр',
  'robot.rapidFireValue': '4 мяча за {s} с',
  'robot.mass': 'Масса',
  'robot.massValue': '{kg} кг',
  'robot.drive': 'Привод',
  'robot.driveValue': '{rpm} RPM · mecanum {mm} мм',
  'robot.speed': 'Скорость',
  'robot.speedValue': 'до {v} м/с',
  'robot.turret': 'Турель',
  'robot.turretValue': '±{deg}°',
  'robot.turrets': 'Турели',
  'robot.turretsValue': '2 × ±{deg}°: POLLEN и NECTAR',
  'robot.intakes': 'Берёт',
  'robot.bothKinds': 'POLLEN и NECTAR',
  'robot.flowerMode': 'Flower Mode',
  'robot.flowerModeYes': 'есть: тянет POLLEN снизу FLOWER',
  'robot.flowerModeNo': 'нет',

  'clock.auto': 'АВТОНОМ',
  'clock.transition': 'Переход',
  'clock.flowersOpen': 'TELEOP · цветы открыты',
  'clock.over': 'Конец матча',

  'score.leave': 'LEAVE (автоном)',
  'score.autoPark': 'PARK (автоном)',
  'score.autoTips': 'HIVE TIP (автоном)',
  'score.teleopTips': 'HIVE TIP (TeleOp)',
  'score.cell': 'Мячи в верхней ячейке',
  'score.flowerBottom': 'Нижний NECTAR в цветке',
  'score.ownedFlower': 'Мячи в своих цветах',
  'score.garden': 'Мячи в GARDEN',
  'score.teleopPark': 'PARK (конец матча)',
  'score.fouls': 'Фолы соперника',

  'results.top': 'Результаты матча',
  'results.red': 'Красный альянс',
  'results.blue': 'Синий альянс',
  'results.winner': 'ПОБЕДА',
  'results.tie': 'НИЧЬЯ',
  'results.dq': 'Дисквалификация: красная карточка',
  'results.calls': 'Нарушения',
  'results.again': 'ещё раз',
  'results.menu': 'меню',
  'results.match': 'Матч {n}',
  'results.solo': 'UrSim · одиночная игра',
  'results.split': 'UrSim · два игрока',
  'results.personalBest': 'Личный рекорд',
  'results.topScore': 'Рекорд UrSim',
  'results.rank': 'Рекорд · место {rank}',
  'call.VERBAL WARNING': 'предупреждение',
  'call.YELLOW CARD': 'жёлтая карточка',
  'call.RED CARD': 'красная карточка',

  'records.about': 'Лучшие результаты одиночных матчей 2:30 — топ 100 для каждого робота. У каждого игрока одна строчка: его лучший счёт.',
  'records.name': 'Твоё имя в таблице',
  'records.loading': 'Загрузка…',
  'records.offline': 'Сервер рекордов недоступен. Попробуй позже.',
  'records.empty': 'Пока пусто — сыграй «Матч 2:30» и стань первым!',
  'records.points': 'Очки',
  'records.date': 'Дата',
};

export type TextKey = keyof typeof ru;

const en: Record<TextKey, string> = {
  'common.back': 'Back',
  'common.backArrow': '← Back',
  'common.on': 'On',
  'common.off': 'Off',
  'common.player': 'Player',
  'common.namePlaceholder': 'For example: Max',

  'loading.field': 'Loading the BIOBUZZ field…',
  'loading.failed': 'Could not load the game. Details are in the console (F12).',
  'arena.subtitle': 'FIRST Tech Challenge simulator',

  'menu.play': 'Play',
  'menu.records': 'High scores',
  'menu.settings': 'Settings',
  'menu.match': 'Match 2:30',
  'menu.practice': 'Practice',
  'menu.legal': 'Unofficial fan-made simulator. Not affiliated with FIRST®. BIOBUZZ™ is a trademark of FIRST.',
  'menu.noPad': 'No gamepad found — press any button on a gamepad or play with the keyboard',
  'menu.unsupportedPad': 'A connected gamepad is not supported. Only PS4, PS5 and Logitech F310 work.',

  'pause.title': 'Paused',
  'pause.resume': 'Resume',
  'pause.restart': 'Restart',
  'pause.toMenu': 'Main menu',

  'settings.tab.controls': 'Controls',
  'settings.tab.graphics': 'Graphics',
  'settings.tab.rules': 'Rules',
  'settings.tab.language': 'Language',
  'settings.gamepads': 'Gamepads →',
  'settings.action': 'Action',
  'settings.gamepad': 'Gamepad',
  'settings.pressButton': 'Press a button…',
  'settings.pressKey': 'Press a key…',
  'settings.controlsNote': 'Click a button in the table, then press the gamepad button or key you want (Esc cancels). If it is already taken, the two actions swap. With two gamepads, gamepad2 drives its own robot on its half of the screen; as "Operator (FTC)" it runs the mechanisms of gamepad1\'s robot instead, as in FTC. R on the keyboard restarts.',
  'settings.resetControls': 'Reset controls',
  'settings.quality': 'Quality',
  'settings.quality.auto': 'Auto (by FPS)',
  'settings.quality.high': 'High',
  'settings.quality.medium': 'Medium',
  'settings.quality.low': 'Low',
  'settings.shadows': 'Shadows',
  'settings.outlines': 'Black outlines',
  'settings.antialias': 'Anti-aliasing',
  'settings.driveSensitivity': 'Drive sensitivity',
  'settings.turnSensitivity': 'Turn sensitivity',
  'settings.fps': 'FPS counter',
  'settings.graphicsNote': '"Auto" lowers resolution and shading by itself when FPS drops below 50 and brings them back when there is headroom. If the game lags, turn off shadows and choose "Low".',
  'settings.fouls': 'Fouls (points to the opponent)',
  'settings.cards': 'Warnings and cards',
  'settings.battery': 'Battery (drains, robot slows down)',
  'settings.rule.G402': 'In AUTO, leave the opponent\'s balls and robot on their half alone — MAJOR FOUL',
  'settings.rule.G405': 'Don\'t eject balls out of the field (a missed shot doesn\'t count) — MAJOR FOUL per ball',
  'settings.rule.G408': 'Don\'t control the opponent\'s NECTAR — VERBAL WARNING, then YELLOW CARD',
  'settings.rule.G410': 'NECTAR into a FLOWER only in the last minute — MAJOR FOUL per NECTAR',
  'settings.rule.G417': 'Don\'t ram the HIVE frame — VERBAL WARNING, then MAJOR FOUL and YELLOW CARD',
  'settings.rule.G421': 'Don\'t pin an opponent for more than 3 s — MAJOR FOUL, plus one more every 3 s',
  'settings.rulesNote': 'The referee works in "Match 2:30". A MINOR FOUL gives the opponent 5 points, a MAJOR 20; a second YELLOW CARD becomes a RED CARD: 0 points for the match.',
  'settings.language': 'Interface language',
  'settings.languageNote': 'FTC terms such as POLLEN, NECTAR, HIVE, AUTO, TELEOP and MAJOR FOUL stay as they are in the game manual.',

  'action.forward': 'Drive forward',
  'action.backward': 'Drive backward',
  'action.left': 'Strafe left',
  'action.right': 'Strafe right',
  'action.turnLeft': 'Turn left',
  'action.turnRight': 'Turn right',
  'action.intake': 'Intake: pick up balls (hold)',
  'action.eject': 'Eject balls (hold)',
  'action.transfer': 'Transfer to the shooter (hold)',
  'action.shooterOn': 'Shooter on',
  'action.shooterOff': 'Shooter off',
  'action.armUp': 'Flower Mode off (arm up)',
  'action.armDown': 'Flower Mode on: take from a FLOWER',
  'action.slow': 'Slow mode',
  'action.fieldCentric': 'Field-centric ↔ Robot-centric',
  'action.imuReset': 'Reset heading (IMU)',
  'action.camera': '"Follow robot" camera: forward / back',
  'action.pause': 'Pause',

  'camera.driver': 'Driver view',
  'camera.audience': 'Audience view',
  'camera.follow': 'Follow robot',

  'pad.keyboard': 'Keyboard',
  'pad.unsupported': 'Unsupported gamepad',
  'pad.connected': '{model} connected → gamepad{n}',
  'pad.disconnected': 'gamepad1 disconnected — keyboard controls',
  'pad.disconnected2': 'gamepad2 disconnected',

  'label.touchpad': 'Touchpad',
  'label.leftStick': 'Left stick',
  'label.rightStick': 'Right stick',

  'control.a': 'a (✕ / A)',
  'control.b': 'b (○ / B)',
  'control.x': 'x (□ / X)',
  'control.y': 'y (△ / Y)',
  'control.dpad_up': 'd-pad up',
  'control.dpad_down': 'd-pad down',
  'control.dpad_left': 'd-pad left',
  'control.dpad_right': 'd-pad right',
  'control.left_bumper': 'left bumper (L1 / LB)',
  'control.right_bumper': 'right bumper (R1 / RB)',
  'control.left_trigger': 'left trigger (L2 / LT)',
  'control.right_trigger': 'right trigger (R2 / RT)',
  'control.left_stick_x': 'left stick RIGHT',
  'control.left_stick_y': 'left stick UP',
  'control.right_stick_x': 'right stick RIGHT',
  'control.right_stick_y': 'right stick UP',
  'control.left_stick_button': 'left stick press (L3)',
  'control.right_stick_button': 'right stick press (R3)',
  'control.back': 'Share / Create / Back',
  'control.start': 'Options / Start',
  'control.guide': 'PS / Logitech',
  'control.touchpad': 'touchpad (PlayStation only)',

  'pads.title': 'Gamepads',
  'pads.about': 'Supported: PS4 DualShock 4, PS5 DualSense and Logitech F310, as on the FTC Driver Station. The F310 has a switch on the back: "X" on Windows, "D" on Mac.',
  'pads.none': 'Not connected',
  'pads.ready': 'Ready',
  'pads.readyCustom': 'Ready · custom button setup',
  'pads.needsSetup': 'Buttons need setting up',
  'pads.setup': 'Set up buttons',
  'pads.reset': 'Reset',
  'pads.swap': 'Swap gamepad1 ↔ gamepad2',
  'pads.unsupported': 'Not supported: {id}',
  'pads.testerHint': 'Connect a gamepad and press any button — a button tester will appear here.',
  'pads.tester': 'Test: gamepad{n}',
  'pads.step': '{model} · step {step} of {count}',
  'pads.move': 'Push ',
  'pads.press': 'Press ',
  'pads.wizardNote': 'While you set it up, the gamepad does not drive the menu — use the mouse or keyboard.',
  'pads.skip': 'Skip',
  'pads.cancel': 'Cancel',

  'select.title': 'Match settings',
  'select.alliance': 'Alliance',
  'select.camera': 'Camera',
  'select.drive': 'Drive mode',
  'select.name': 'Name',
  'select.namePlaceholder': 'For high scores',
  'select.robots': 'Robots',
  'select.red': 'Red',
  'select.blue': 'Blue',
  'select.pad2': 'gamepad2',
  'select.pad2Robot': 'Own robot',
  'select.pad2Operator': 'Operator (FTC)',
  'select.robot2': 'gamepad2 robot',
  'select.alliance2': 'gamepad2 alliance',
  'select.splitNote': 'two players, split screen',
  'select.start': 'Start',
  'robot.rapidFire': 'Rapid fire',
  'robot.rapidFireValue': '4 balls in {s} s',
  'robot.mass': 'Weight',
  'robot.massValue': '{kg} kg',
  'robot.drive': 'Drive',
  'robot.driveValue': '{rpm} RPM · {mm} mm mecanum',
  'robot.speed': 'Top speed',
  'robot.speedValue': '{v} m/s',
  'robot.turret': 'Turret',
  'robot.turretValue': '±{deg}°',
  'robot.turrets': 'Turrets',
  'robot.turretsValue': '2 × ±{deg}°: POLLEN and NECTAR',
  'robot.intakes': 'Picks up',
  'robot.bothKinds': 'POLLEN and NECTAR',
  'robot.flowerMode': 'Flower Mode',
  'robot.flowerModeYes': "yes: pulls POLLEN out of a FLOWER's bottom",
  'robot.flowerModeNo': 'no',

  'clock.auto': 'AUTO',
  'clock.transition': 'Transition',
  'clock.flowersOpen': 'TELEOP · FLOWERS open',
  'clock.over': 'Match over',

  'score.leave': 'LEAVE (AUTO)',
  'score.autoPark': 'PARK (AUTO)',
  'score.autoTips': 'HIVE TIP (AUTO)',
  'score.teleopTips': 'HIVE TIP (TeleOp)',
  'score.cell': 'Balls in the upward cell',
  'score.flowerBottom': 'Bottom NECTAR in a FLOWER',
  'score.ownedFlower': 'Balls in owned FLOWERS',
  'score.garden': 'Balls in the GARDEN',
  'score.teleopPark': 'PARK (end of match)',
  'score.fouls': 'Opponent fouls',

  'results.top': 'Match Results',
  'results.red': 'Red Alliance',
  'results.blue': 'Blue Alliance',
  'results.winner': 'WINNER',
  'results.tie': 'TIE',
  'results.dq': 'Disqualified: RED CARD',
  'results.calls': 'Penalties',
  'results.again': 'again',
  'results.menu': 'menu',
  'results.match': 'Match {n}',
  'results.solo': 'UrSim · solo play',
  'results.split': 'UrSim · two players',
  'results.personalBest': 'Personal best',
  'results.topScore': 'UrSim record',
  'results.rank': 'High score · #{rank}',
  'call.VERBAL WARNING': 'VERBAL WARNING',
  'call.YELLOW CARD': 'YELLOW CARD',
  'call.RED CARD': 'RED CARD',

  'records.about': 'Best solo 2:30 match scores — the top 100 for each robot. Each player gets one line: their best score.',
  'records.name': 'Your name in the table',
  'records.loading': 'Loading…',
  'records.offline': 'The high score server is unavailable. Try again later.',
  'records.empty': 'Nothing here yet — play "Match 2:30" and be the first!',
  'records.points': 'Points',
  'records.date': 'Date',
};

export const TEXTS: Record<Language, Record<TextKey, string>> = { ru, en };

/** Russian for a browser set to Russian, English for everyone else. */
export function languageFor(browserLanguage: string): Language {
  return browserLanguage.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function defaultLanguage(): Language {
  return languageFor(typeof navigator === 'undefined' ? '' : navigator.language ?? '');
}

let current: Language = defaultLanguage();

export function language(): Language {
  return current;
}

export function setLanguage(lang: Language): void {
  current = lang;
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

/** `key` in the current language, with {name} placeholders filled from `params`. */
export function t(key: TextKey, params?: Record<string, string | number>): string {
  const text = TEXTS[current][key];
  return params ? text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? '')) : text;
}

/** Shows `key` in `el` (as the placeholder of an input) and remembers it for localize(). */
export function setText(el: HTMLElement, key: TextKey): void {
  el.dataset.t = key;
  if (el instanceof HTMLInputElement) el.placeholder = t(key);
  else el.textContent = t(key);
}

/** h() for an element whose whole text is `key`; localize() keeps it in the current language. */
export function ht<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props, key: TextKey): HTMLElementTagNameMap[K] {
  const el = h(tag, props);
  setText(el, key);
  return el;
}

/** Puts every ht() / setText() text under `root` into the current language. */
export function localize(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-t]')) setText(el, el.dataset.t as TextKey);
}
