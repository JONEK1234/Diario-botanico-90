/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Plant, PlantStatus, PlantOrigin, CareActivity } from "../types";

export const PRESET_PLANTS: Plant[] = [
  {
    id: "plant-monstera",
    name: "Monstera Deliciosa",
    nickname: "Vortice Verde",
    species: "Philodendron / Araceae",
    origin: PlantOrigin.ACQUISTO,
    startDate: "2025-09-10",
    description: "Trovata in un piccolo mercato della Liguria. Era sofferente, ora è la regina del soggiorno. Sviluppa foglie maestose e fenestrate in cerca della luce filtrata dello studio.",
    imageUrl: "https://images.unsplash.com/photo-1614594975525-e45190c55d0b?auto=format&fit=crop&q=80&w=800",
    status: PlantStatus.CRESCITA,
    health: 95,
    notes: "Tollera bene l'asciutto occasionale, odia il ristagno idrico. Preferisce nebulizzazioni sulle radici aeree.",
    tags: ["Interno", "Luce Indiretta", "Araceae"],
    diary: [
      {
        id: "m-1",
        date: "2025-09-11",
        eventTitle: "Arrivo a Casa",
        notes: "Sistemata vicino alla finestra esposta a Est. Substrato molto drenante con fibra di cocco e perlite.",
        category: "creazione"
      },
      {
        id: "m-2",
        date: "2025-10-15",
        eventTitle: "Prima nuova foglia fenestrata",
        notes: "Una foglia splendida si sta srotolando. Presenta già tre fenestrazioni complete. Gesto fantastico della natura.",
        imageUrl: "https://images.unsplash.com/photo-1500417148159-68083bd7333a?auto=format&fit=crop&q=80&w=800",
        category: "evoluzione"
      },
      {
        id: "m-3",
        date: "2026-02-12",
        eventTitle: "Inserimento Palo di Muschio",
        notes: "Abbiamo montato un supporto verticale umido in fibra di cocco. Le radici aeree hanno iniziato ad aggrapparsi quasi subito.",
        category: "rinvaso"
      },
      {
        id: "m-4",
        date: "2026-06-01",
        eventTitle: "Ispezione Foglie Estate",
        notes: "Pulite le foglie con un panno in microfibra umido per rimuovere la polvere accumulata. Splendore lucido e naturale.",
        category: "osservazione"
      }
    ]
  },
  {
    id: "plant-strelitzia",
    name: "Strelitzia Reginae",
    nickname: "Aura",
    species: "Strelitziaceae",
    origin: PlantOrigin.ACQUISTO,
    startDate: "2025-05-18",
    description: "Una splendida varietà di Uccello del Paradiso acquistata per celebrare la nuova serra domestica. Foglie allungate a forma di voga, resistenti e di un verde oliva leggermente ceroso.",
    imageUrl: "https://images.unsplash.com/photo-1545241047-6083a3684587?auto=format&fit=crop&q=80&w=800",
    status: PlantStatus.FIORITURA,
    health: 100,
    notes: "Molta luce solare diretta. Terreno argilloso e ricco, annaffiare generosamente ma con pause asciutte.",
    tags: ["Serra", "Sole Diretto", "Esotica"],
    diary: [
      {
        id: "s-1",
        date: "2025-05-18",
        eventTitle: "Accoglienza in Serra",
        notes: "Posizionata nell'angolo più esposto a Sud. Sembra felice del calore naturale del vetro.",
        category: "creazione"
      },
      {
        id: "s-2",
        date: "2025-07-20",
        eventTitle: "Crescita Accelerata",
        notes: "Con il calore estivo, ha generato due foglie monumentali di circa 40cm. Concimazione bisettimanale con estratto di alghe.",
        category: "concimazione"
      },
      {
        id: "s-3",
        date: "2026-05-30",
        eventTitle: "Inizio Primo Germoglio Floreale",
        notes: "Incredibile sorpresa: alla base si scorge la guaina robusta e appuntita del futuro fiore. Estremamente emozionante!",
        imageUrl: "https://images.unsplash.com/photo-1501004318641-724e63f7664c?auto=format&fit=crop&q=80&w=800",
        category: "evoluzione"
      }
    ]
  },
  {
    id: "plant-pilea",
    name: "Pilea Peperomioides",
    nickname: "Fiorino",
    species: "Pilea / Urticaceae",
    origin: PlantOrigin.TALEA,
    startDate: "2026-01-05",
    description: "Regalata da un caro amico botanico come piccola talea radicata in acqua. Conosciuta comunemente come Pianta dei Soldi Cinesi per le sue graziose foglie tondeggianti sospese su lunghi piccioli.",
    imageUrl: "https://images.unsplash.com/photo-1599599810769-bcde5a160d32?auto=format&fit=crop&q=80&w=800",
    status: PlantStatus.PROPAGAZIONE,
    health: 90,
    notes: "Gira la pianta di 90 gradi ogni settimana per mantenere lo stelo dritto ed evitare che si pieghi in cerca della luce.",
    tags: ["Mini", "Pilea", "Living-Room", "Regalo"],
    diary: [
      {
        id: "p-1",
        date: "2026-01-05",
        eventTitle: "Invasatura Talea",
        notes: "Messa a dimora in un piccolo vasetto di terracotta. Substrato soffice con sabbia silicea e compost fine.",
        category: "creazione"
      },
      {
        id: "p-2",
        date: "2026-03-22",
        eventTitle: "Piccole Rosette alla Base",
        notes: "Ha fatto ben tre 'figlioli' sotterranei! Piccolissime pilee crescono proprio alla base dello stelo madre.",
        category: "evoluzione"
      }
    ]
  },
  {
    id: "plant-ficus",
    name: "Ficus Lyrata",
    nickname: "Lyra",
    species: "Moraceae",
    origin: PlantOrigin.RECUPERO,
    startDate: "2025-11-20",
    description: "Recuperata da un ufficio dismesso in cui era stata dimenticata al buio. Aveva perso quasi tutte le foglie inferiori, ma la sua tenacia ha stupito tutti. Oggi si sviluppa slanciata a forma di violino.",
    imageUrl: "https://images.unsplash.com/photo-1597055181300-e3633a207518?auto=format&fit=crop&q=80&w=800",
    status: PlantStatus.RECUPERO,
    health: 78,
    notes: "Molto sensibile agli sbalzi di temperatura e alle correnti d'aria gelida. Bagna solo quando il primo pollice di terreno è totalmente asciutto.",
    tags: ["Ficus", "Lentezza", "Salvataggio"],
    diary: [
      {
        id: "f-1",
        date: "2025-11-20",
        eventTitle: "Missione Salvataggio",
        notes: "Rimossa dal vecchio ufficio. Le radici erano asfissiate. Potate le parti marce, rinvasata d'urgenza.",
        category: "rinvaso"
      },
      {
        id: "f-2",
        date: "2026-02-10",
        eventTitle: "Primi segni di ripresa",
        notes: "Nessun ulteriore ingiallimento o caduta di foglie negli ultimi 30 giorni. La gemma apicale mostra un barlume verde.",
        category: "osservazione"
      },
      {
        id: "f-3",
        date: "2026-05-15",
        eventTitle: "Nuova foglia apicale mastodontica",
        notes: "Successo! Dalla gemma si è espansa la prima nuova foglia dell'anno, lucente, sana e nervata di verde chiaro.",
        category: "evoluzione"
      }
    ]
  }
];

export const PRESET_ACTIVITIES: CareActivity[] = [
  {
    id: "act-1",
    plantId: "plant-monstera",
    type: "annaffiatura",
    title: "Verifica umidità e annaffia",
    status: "todo",
    dueDate: "2026-06-16",
    priority: "media"
  },
  {
    id: "act-2",
    plantId: "plant-strelitzia",
    type: "concimazione",
    title: "Fertilizzante liquido a base organica",
    status: "todo",
    dueDate: "2026-06-18",
    priority: "alta"
  },
  {
    id: "act-3",
    plantId: "plant-ficus",
    type: "pulizia",
    title: "Spolvera le foglie giganti",
    status: "todo",
    dueDate: "2026-06-20",
    priority: "bassa"
  },
  {
    id: "act-4",
    plantId: "plant-pilea",
    type: "luce",
    title: "Rotazione vaso di 90 gradi",
    status: "completed",
    dueDate: "2026-06-14",
    priority: "bassa",
    completedAt: "2026-06-14T17:30:00Z",
    completedNotes: "Ruotato in senso orario. Le rosette inferiori iniziano a ricevere luce ottimale."
  },
  {
    id: "act-5",
    plantId: "plant-monstera",
    type: "pulizia",
    title: "Nebulizza le foglie con acqua demineralizzata",
    status: "completed",
    dueDate: "2026-06-15",
    priority: "media",
    completedAt: "2026-06-15T08:00:00Z",
    completedNotes: "Eseguita di mattina presto. Rinfrescate tutte le bellissime foglie fenestrate."
  }
];
