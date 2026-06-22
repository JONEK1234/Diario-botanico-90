/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export enum PlantStatus {
  GERMOGLIO = "germoglio",
  CRESCITA = "crescita",
  STABILE = "stabile",
  FIORITURA = "fioritura",
  STRESS = "stress",
  RECUPERO = "recupero",
  RINVASATA = "rinvasata",
  PROPAGAZIONE = "propagazione",
}

export enum PlantOrigin {
  SEME = "seme",
  TALEA = "talea",
  ACQUISTO = "acquisto",
  TRAPIANTO = "trapianto",
  RECUPERO = "recupero",
}

export interface DiaryEntry {
  id: string;
  date: string; // ISO String
  eventTitle: string;
  notes: string;
  imageUrl?: string;
  category?: "creazione" | "annaffiatura" | "concimazione" | "rinvaso" | "generale" | "osservazione" | "evoluzione";
}

export interface Plant {
  id: string;
  name: string;
  nickname: string;
  species: string;
  origin: PlantOrigin;
  startDate: string; // ISO String or YYYY-MM-DD
  description: string;
  imageUrl: string;
  status: PlantStatus;
  health: number; // 0 to 100
  notes: string;
  tags: string[];
  diary: DiaryEntry[];
  isDead?: boolean;
  deathDate?: string;
  deathNotes?: string;
}

export interface CareActivity {
  id: string;
  plantId: string;
  type: "annaffiatura" | "concimazione" | "rinvaso" | "propagazione" | "pulizia" | "luce" | "umidita" | "ispezione" | "generale";
  title: string;
  status: "todo" | "completed";
  dueDate: string; // YYYY-MM-DD
  priority: "bassa" | "media" | "alta";
  completedAt?: string; // ISO String
  completedNotes?: string;
}

export interface SmartTracker {
  id: string;
  title: string;
  startDate: string; // YYYY-MM-DD
  durationDays: number;
  isCompleted: boolean;
  completedAt?: string;
  notes?: string;
  checkIns?: string[];
}

export interface JournalState {
  plants: Plant[];
  activities: CareActivity[];
  smartTrackers?: SmartTracker[];
  settings: {
    userName: string;
    gardenName: string;
    offlineMode: boolean;
  };
}
