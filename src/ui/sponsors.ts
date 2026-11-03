// Who supports the game (public/assets/sponsors): their logos are in the main menu's bottom right
// corner (ui/menus.ts) and on the LED boards around the field (view/HallAds.ts).

export interface Sponsor {
  src: string;
  name: string;
  /** A square logo (a picture over the name) */
  square?: boolean;
}

export const SPONSORS: Sponsor[] = [
  { src: 'assets/sponsors/ustem-foundation.png', name: 'USTEM Foundation' },
  { src: 'assets/sponsors/ustem-academy.png', name: 'USTEM Academy', square: true },
  { src: 'assets/sponsors/24saas.png', name: '24 SaaS' },
];
