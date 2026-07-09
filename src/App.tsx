/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Sprout,
  Droplet,
  Check,
  Plus,
  Search,
  Share2,
  Download,
  Trash2,
  Edit,
  Activity,
  Sparkles,
  Calendar,
  ChevronRight,
  Eye,
  RefreshCcw,
  X,
  FileText,
  Heart,
  CalendarClock,
  Filter,
  CheckSquare,
  Square,
  Upload,
  BookOpen,
  CloudLightning,
  Info,
  ArrowUp,
  ArrowDown,
  Copy,
  Skull,
  HeartOff,
  ArrowLeft,
  History,
  Image as ImageIcon
} from "lucide-react";
import { JournalState, Plant, CareActivity, PlantStatus, PlantOrigin, DiaryEntry, SmartTracker, SavedNote } from "./types";
import { SavedNotesView } from "./components/SavedNotesView";
import { PRESET_PLANTS, PRESET_ACTIVITIES } from "./data/presetPlants";
import JSZip from "jszip";

const getApiUrl = (endpoint: string): string => {
  if (typeof window === "undefined") return endpoint;
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host.startsWith("192.168.")) {
    return endpoint;
  }
  const baseUrl = "https://ais-pre-sx4htuchmf4s4oselbkdae-210149562905.europe-west2.run.app";
  return `${baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
};

const toLocalDatetimeString = (isoString: string): string => {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return "";
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

// --- GRUPPO STRUMENTALE COMPRESSIONE IMMAGINI (Previene blocchi DB Firestore 1MB) ---
const compressImage = (base64Str: string, maxWidth = 500, quality = 0.5): Promise<string> => {
  return new Promise((resolve) => {
    if (!base64Str || !base64Str.startsWith("data:image/")) {
      resolve(base64Str);
      return;
    }
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;

      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(base64Str);
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);
      // Forza salvataggio in formato JPEG super compresso
      const compressed = canvas.toDataURL("image/jpeg", quality);
      resolve(compressed);
    };
    img.onerror = () => {
      resolve(base64Str);
    };
    img.src = base64Str;
  });
};

const compressFile = (file: File, maxWidth = 500, quality = 0.5): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64Raw = e.target?.result as string;
      if (file.type.startsWith("image/")) {
        try {
          const compressed = await compressImage(base64Raw, maxWidth, quality);
          resolve(compressed);
        } catch (err) {
          resolve(base64Raw);
        }
      } else {
        resolve(base64Raw);
      }
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
};

// Ottimizza e comprime ricorsivamente tutte le immagini presenti nello stato per salvare quintali di spazio
const compressStateImages = async (stateToSave: JournalState): Promise<JournalState> => {
  if (!stateToSave || !stateToSave.plants) return stateToSave;
  
  const compressedPlants = await Promise.all(
    stateToSave.plants.map(async (plant) => {
      let compressedImg = plant.imageUrl;
      // Comprime solo se è una stringa base64 lunga superiore a 67KB (~50KB binari)
      if (plant.imageUrl && plant.imageUrl.startsWith("data:image/") && plant.imageUrl.length > 67000) {
        try {
          compressedImg = await compressImage(plant.imageUrl, 500, 0.4);
        } catch (_) {}
      }

      let compressedDiary = plant.diary;
      if (plant.diary && plant.diary.length > 0) {
        compressedDiary = await Promise.all(
          plant.diary.map(async (entry) => {
            let entryImg = entry.imageUrl;
            if (entry.imageUrl && entry.imageUrl.startsWith("data:image/") && entry.imageUrl.length > 67000) {
              try {
                entryImg = await compressImage(entry.imageUrl, 500, 0.4);
              } catch (_) {}
            }
            return { ...entry, imageUrl: entryImg };
          })
        );
      }

      return {
        ...plant,
        imageUrl: compressedImg,
        diary: compressedDiary,
      };
    })
  );

  return {
    ...stateToSave,
    plants: compressedPlants,
  };
};

// Rimuove ricorsivamente le chiavi "undefined" prevenendo fallimenti della setDoc in Firestore
const sanitizeFirestorePayload = (obj: any): any => {
  if (obj === undefined) return null;
  return JSON.parse(JSON.stringify(obj));
};

export default function App() {
  // Modalità Sola Lettura gestita dinamicamente per supportare il single-app editor/viewer toggle!
  const [isReadOnlyMode, setIsReadOnlyMode] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const savedMode = localStorage.getItem("flora_auth_mode");
      if (savedMode === "editor") {
        return false;
      }
    }
    return true; // Di default parte in modalità visualizzatore (Sola Lettura)
  });

  // 1. CARICAMENTO STATO INIZIALE (Supporto Standalone Offline ed State Management locale)
  const getInitialState = (): JournalState => {
    // Controlla se ci sono dati iniettati dal compilatore standalone
    const injectedData = (window as any).__MY_APP_INITIAL_DATA__;
    if (injectedData && injectedData.plants) {
      return {
        ...injectedData,
        smartTrackers: injectedData.smartTrackers || []
      };
    }

    // Controlla se la share URL contiene dati compressi
    if (typeof window !== "undefined" && window.location.hash.startsWith("#share=")) {
      try {
        const hashData = window.location.hash.replace("#share=", "");
        // Decodifica super robusta compatibile UTF-8 per ripristinare correttamente le lettere accentate
        let decoded = "";
        try {
          decoded = decodeURIComponent(escape(atob(hashData)));
        } catch (_) {
          try {
            decoded = decodeURIComponent(atob(hashData));
          } catch (__) {
            decoded = atob(hashData);
          }
        }
        const parsed = JSON.parse(decoded);
        if (parsed.plants) {
          return {
            plants: parsed.plants,
            activities: parsed.activities || [],
            smartTrackers: parsed.smartTrackers || [],
            settings: parsed.settings || { userName: "Ospite", gardenName: "Giardino Condiviso", offlineMode: false }
          };
        }
      } catch (e) {
        console.error("Errore decodifica share link:", e);
      }
    }

    // Altrimenti, carica il localStorage standard
    const saved = localStorage.getItem("flora_journal_db");
    const defaultTrackersPreset: SmartTracker[] = [
      {
        id: "tracker-preset-1",
        title: "Talea di Rosa canina",
        startDate: new Date(Date.now() - 21 * 60 * 60 * 1000).toISOString().split("T")[0], // Ieri (all'incirca)
        durationDays: 21,
        isCompleted: false,
        notes: "Radicazione in terriccio sabbioso umido. Mantenere sotto cappuccio di plastica per conservare l'umidità costante."
      },
      {
        id: "tracker-preset-2",
        title: "Germinazione Sementi Pomodoro",
        startDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split("T")[0], // 5 giorni fa
        durationDays: 10,
        isCompleted: false,
        notes: "Prima comparsa dei cotiledoni. Trapiantare in vasetto singolo alla comparsa della terza foglia vera."
      }
    ];

    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.plants && parsed.plants.length > 0) {
          // Migrazione da Elena a Samuel
          if (!parsed.settings) {
            parsed.settings = { userName: "Samuel", gardenName: "Orto Botanico di Samuel", offlineMode: false };
          } else {
            if (parsed.settings.userName === "Elena" || parsed.settings.userName === "elena" || parsed.settings.userName === "Ospite") {
              parsed.settings.userName = "Samuel";
            }
            if (!parsed.settings.gardenName || parsed.settings.gardenName.includes("Elena") || parsed.settings.gardenName.includes("elena") || parsed.settings.gardenName === "Orto Botanico" || parsed.settings.gardenName.includes("di Samuel di Samuel")) {
              parsed.settings.gardenName = (parsed.settings.gardenName || "").replace(/Elena/g, "Samuel").replace(/elena/g, "Samuel");
              if (!parsed.settings.gardenName || parsed.settings.gardenName === "Orto Botanico") {
                parsed.settings.gardenName = "Orto Botanico di Samuel";
              }
            }
            if (parsed.settings.gardenName && parsed.settings.gardenName.includes("di Samuel di Samuel")) {
              parsed.settings.gardenName = parsed.settings.gardenName.replace(/di Samuel di Samuel/g, "di Samuel");
            }
          }
          return {
            ...parsed,
            smartTrackers: parsed.smartTrackers !== undefined ? parsed.smartTrackers : defaultTrackersPreset
          };
        }
      } catch (e) {
        console.error("Errore lettura localStorage:", e);
      }
    }

    // Fallback sui presets magnifici creati
    return {
      plants: PRESET_PLANTS,
      activities: PRESET_ACTIVITIES,
      smartTrackers: defaultTrackersPreset,
      settings: {
        userName: "Samuel",
        gardenName: "Orto Botanico di Samuel",
        offlineMode: false,
      }
    };
  };

  const [state, setState] = useState<JournalState>(() => {
    return getInitialState();
  });

  const [selectedPlantId, setSelectedPlantId] = useState<string>(() => {
    const savedId = typeof window !== "undefined" ? localStorage.getItem("flora_selected_plant_id") : null;
    const initialDb = getInitialState();
    if (savedId && initialDb.plants.some(p => p.id === savedId)) {
      return savedId;
    }
    return initialDb.plants.length > 0 ? initialDb.plants[0].id : "";
  });

  // Filtri & Ricerca
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<string>("all");
  const [selectedTagFilter, setSelectedTagFilter] = useState<string>("all");

  // Stato Modali / Form
  const [isAddPlantOpen, setIsAddPlantOpen] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("flora_is_add_plant_open") === "true";
    }
    return false;
  });
  const [isEditPlantOpen, setIsEditPlantOpen] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("flora_is_edit_plant_open") === "true";
    }
    return false;
  });
  const [isNewDiaryOpen, setIsNewDiaryOpen] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("flora_is_new_diary_open") === "true";
    }
    return false;
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("flora_is_settings_open") === "true";
    }
    return false;
  });
  const [isAddActivityOpen, setIsAddActivityOpen] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("flora_is_add_activity_open") === "true";
    }
    return false;
  });
  const [plantIdToDelete, setPlantIdToDelete] = useState<string | null>(null);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [generatedShareUrl, setGeneratedShareUrl] = useState("");
  const [isCopiedSuccess, setIsCopiedSuccess] = useState(false);

  // Connection states for Live Synchronization and PWA Installation
  const [activeShareId, setActiveShareId] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("flora_active_share_id") || "samuel-garden";
    }
    return "samuel-garden";
  });
  const [isCloudLoaded, setIsCloudLoaded] = useState(false);
  const [syncClicks, setSyncClicks] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatusMessage, setSyncStatusMessage] = useState<string | null>(null);

  enum OperationType {
    CREATE = 'create',
    UPDATE = 'update',
    DELETE = 'delete',
    LIST = 'list',
    GET = 'get',
    WRITE = 'write',
  }

  const handleFirestoreError = (error: unknown, operationType: OperationType, path: string | null) => {
    const errInfo = {
      error: error instanceof Error ? error.message : String(error),
      operationType,
      path,
      authInfo: {
        userId: null,
        email: null,
        emailVerified: null,
        isAnonymous: null,
      }
    };
    console.error('Firestore Error: ', JSON.stringify(errInfo));
    throw new Error(JSON.stringify(errInfo));
  };
  const [pwaPrompt, setPwaPrompt] = useState<any>(null);
  const [pwaBannerDismissed, setPwaBannerDismissed] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("flora_pwa_dismissed") === "true";
    }
    return false;
  });
  const [isPwaInstalled, setIsPwaInstalled] = useState(false);

  // Stati per Piante Morte e Memoriale
  const [isDeathModalOpen, setIsDeathModalOpen] = useState(false);
  const [fullscreenImageUrl, setFullscreenImageUrl] = useState<string | null>(null);
  const [plantIdToDeclareDead, setPlantIdToDeclareDead] = useState<string | null>(null);
  const [deathNotesInput, setDeathNotesInput] = useState("");
  const [isMemorialOpen, setIsMemorialOpen] = useState(false);

  // Stati per Agenda Globale Botanica e Smart Trackers
  const [isAgendaOpen, setIsAgendaOpen] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("flora_is_agenda_open") === "true";
    }
    return false;
  });
  const [isHistoryOpen, setIsHistoryOpen] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("flora_is_history_open") === "true";
    }
    return false;
  });
  const [isAddTrackerOpen, setIsAddTrackerOpen] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("flora_is_add_tracker_open") === "true";
    }
    return false;
  });
  const [newTrackerForm, setNewTrackerForm] = useState(() => {
    try {
      const saved = localStorage.getItem("flora_new_tracker_form");
      if (saved) return JSON.parse(saved);
    } catch (_) {}
    return {
      title: "",
      startDate: new Date().toISOString().split("T")[0],
      durationDays: 21,
      notes: ""
    };
  });
  const [agendaFormTitle, setAgendaFormTitle] = useState("");
  const [agendaFormPriority, setAgendaFormPriority] = useState<"bassa" | "media" | "alta">("media");
  const [agendaFormDueDate, setAgendaFormDueDate] = useState(new Date().toISOString().split("T")[0]);

  // Form Attività Personalizzata Nuova
  const [newActivityForm, setNewActivityForm] = useState(() => {
    try {
      const saved = localStorage.getItem("flora_new_activity_form");
      if (saved) return JSON.parse(saved);
    } catch (_) {}
    return {
      title: "",
      type: "generale" as CareActivity["type"],
      priority: "media" as CareActivity["priority"],
      dueDate: new Date().toISOString().split("T")[0]
    };
  });

  // Menù degli aggiornamenti all'inizio per i link condivisi (modalità sola lettura)
  const [showUpdatesMenu, setShowUpdatesMenu] = useState(() => {
    return isReadOnlyMode;
  });

  // Tracciamo se abbiamo già catturato lo stato del giardino al primissimo caricamento o sincronizzazione
  const isInitialCapturedRef = useRef(false);

  // Salviamo in localStorage gli ID visti per non mostrarli di nuovo (modalità sola lettura)
  const [seenUpdates, setSeenUpdates] = useState<{ plantIds: string[], diaryIds: string[], activityIds: string[] }>(() => {
    try {
      const saved = localStorage.getItem("flora_seen_updates_v2");
      if (saved) return JSON.parse(saved);
    } catch (_) {}
    return { plantIds: [], diaryIds: [], activityIds: [] };
  });

  // Cattura e imposta come già visti gli ID storici vecchi (antecedenti al giorno dell'ultimo aggiornamento generale)
  const captureInitialSeenIds = (plants: Plant[], activities: CareActivity[], dbUpdatedAt?: string) => {
    if (isInitialCapturedRef.current) return;
    isInitialCapturedRef.current = true;

    const stored = localStorage.getItem("flora_seen_updates_v2");
    if (stored) return; // Se ha già una cronologia di visualizzazione locale, non facciamo nulla!

    const lastUpdateDay = dbUpdatedAt ? dbUpdatedAt.split("T")[0] : new Date().toISOString().split("T")[0];

    const plantIds: string[] = [];
    (plants || []).forEach(p => {
      if (p.startDate !== lastUpdateDay) {
        plantIds.push(p.id);
      }
    });

    const diaryIds: string[] = [];
    (plants || []).forEach(p => {
      if (p.diary) {
        p.diary.forEach(d => {
          const entryDay = d.date.split("T")[0];
          if (entryDay !== lastUpdateDay) {
            diaryIds.push(d.id);
          }
        });
      }
    });

    const activityIds: string[] = [];
    (activities || []).forEach(a => {
      const activityDay = a.dueDate ? a.dueDate : (a.completedAt ? a.completedAt.split("T")[0] : "");
      if (activityDay !== lastUpdateDay) {
        activityIds.push(a.id);
      }
    });

    const mergedSeen = {
      plantIds,
      diaryIds,
      activityIds
    };

    setSeenUpdates(mergedSeen);
    try {
      localStorage.setItem("flora_seen_updates_v2", JSON.stringify(mergedSeen));
    } catch (_) {}
  };

  // Mostra solo le piante aggiunte quel giorno e non ancora lette
  const getNewPlants = () => {
    if (!state.plants) return [];
    const lastUpdateDay = state.updatedAt ? state.updatedAt.split("T")[0] : new Date().toISOString().split("T")[0];
    const active = state.plants.filter(p => !p.isDead);
    return active.filter(p => p.startDate === lastUpdateDay && !seenUpdates.plantIds.includes(p.id));
  };

  // Mostra solo le modifiche/note di diario di quel giorno non ancora lette
  const getNewUpdates = () => {
    if (!state.plants) return [];
    const lastUpdateDay = state.updatedAt ? state.updatedAt.split("T")[0] : new Date().toISOString().split("T")[0];
    const allEntries: { plant: Plant; entry: DiaryEntry }[] = [];
    state.plants.forEach(p => {
      if (p.diary && !p.isDead) {
        p.diary.forEach(d => {
          allEntries.push({ plant: p, entry: d });
        });
      }
    });
    const filtered = allEntries.filter(({ entry }) => {
      const entryDay = entry.date.split("T")[0];
      return entryDay === lastUpdateDay && !seenUpdates.diaryIds.includes(entry.id);
    });
    filtered.sort((a, b) => {
      const dateA = new Date(a.entry.date).getTime();
      const dateB = new Date(b.entry.date).getTime();
      return dateB - dateA;
    });
    return filtered;
  };

  // Mostra solo le attività pianificate o completate quel giorno non ancora lette
  const getNewPendingActivities = () => {
    if (!state.activities) return [];
    const lastUpdateDay = state.updatedAt ? state.updatedAt.split("T")[0] : new Date().toISOString().split("T")[0];
    const filtered = state.activities.filter(a => {
      const isOfThatDay = a.dueDate === lastUpdateDay || (a.completedAt && a.completedAt.startsWith(lastUpdateDay));
      return isOfThatDay && !seenUpdates.activityIds.includes(a.id);
    });
    filtered.sort((a, b) => {
      const dateA = new Date(a.dueDate).getTime();
      const dateB = new Date(b.dueDate).getTime();
      return dateA - dateB;
    });
    return filtered;
  };

  const handleMarkUpdatesAsSeen = () => {
    const currentPlantIds = (state.plants || []).map(p => p.id);
    const currentDiaryIds: string[] = [];
    (state.plants || []).forEach(p => {
      if (p.diary) {
        p.diary.forEach(d => currentDiaryIds.push(d.id));
      }
    });
    const currentActivityIds = (state.activities || []).map(a => a.id);

    const updatedSeen = {
      plantIds: Array.from(new Set([...seenUpdates.plantIds, ...currentPlantIds])),
      diaryIds: Array.from(new Set([...seenUpdates.diaryIds, ...currentDiaryIds])),
      activityIds: Array.from(new Set([...seenUpdates.activityIds, ...currentActivityIds]))
    };

    setSeenUpdates(updatedSeen);
    try {
      localStorage.setItem("flora_seen_updates_v2", JSON.stringify(updatedSeen));
    } catch (_) {}

    setShowUpdatesMenu(false);
  };

  // Riferimenti per Auto-Scroll Smooth
  const detailsSectionRef = useRef<HTMLDivElement>(null);
  const latestNoteRef = useRef<HTMLDivElement>(null);

  // Form Pianta Nuova / Modifica
  const [newPlantForm, setNewPlantForm] = useState<Partial<Plant>>(() => {
    try {
      const saved = localStorage.getItem("flora_new_plant_form");
      if (saved) return JSON.parse(saved);
    } catch (_) {}
    return {
      name: "",
      nickname: "",
      species: "",
      origin: PlantOrigin.ACQUISTO,
      startDate: new Date().toISOString().split("T")[0],
      description: "",
      imageUrl: "",
      status: PlantStatus.CRESCITA,
      health: 90,
      notes: "",
      tags: []
    };
  });
  const [draftTag, setDraftTag] = useState("");

  // Form Nota Diario Nuova
  const [newDiaryForm, setNewDiaryForm] = useState(() => {
    try {
      const saved = localStorage.getItem("flora_new_diary_form");
      if (saved) return JSON.parse(saved);
    } catch (_) {}
    return {
      eventTitle: "",
      notes: "",
      imageUrl: "",
      category: "osservazione" as DiaryEntry["category"]
    };
  });

  // Stato AI Curator Assistant
  const [aiAnalysis, setAiAnalysis] = useState<string>("");
  const [isAiLoading, setIsAiLoading] = useState(false);

  // Gestione Drop Zone per caricaricamento immagini
  const [isDragging, setIsDragging] = useState(false);
  const [isDraggingEdit, setIsDraggingEdit] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileEditInputRef = useRef<HTMLInputElement>(null);

  // Stato per la gestione della cancellazione di elementi tramite pressione prolungata (Long Press)
  const [deleteConfirmItem, setDeleteConfirmItem] = useState<{
    id: string;
    parentPlantId?: string; // Utilizzato per eliminare le note di diario di una specifica pianta
    type: "activity" | "diary" | "completed-activity";
    title: string;
  } | null>(null);

  // Stato per la gestione della pressione prolungata sulle piante (Long Press)
  const [longPressedPlant, setLongPressedPlant] = useState<Plant | null>(null);

  // Stato per l'apertura del sottomenu delle "Note Salvate" per la pianta selezionata
  const [isSavedNotesViewOpen, setIsSavedNotesViewOpen] = useState(false);

  // Stato per tenere traccia di quali note di diario hanno l'età visualizzata ad oggi (toggled)
  const [toggledDiaryAges, setToggledDiaryAges] = useState<Record<string, boolean>>({});

  // Stato per l'editing di elementi
  const [editingItem, setEditingItem] = useState<{
    id: string;
    parentPlantId?: string;
    type: "activity" | "diary" | "completed-activity";
    title: string;
    notes?: string;
    category?: string;
    activityType?: string;
    priority?: "bassa" | "media" | "alta";
    dueDate?: string;
    imageUrl?: string;
    date?: string;
  } | null>(() => {
    try {
      const saved = localStorage.getItem("flora_editing_item");
      if (saved) return JSON.parse(saved);
    } catch (_) {}
    return null;
  });

  // Per tracciare la pressione prolungata
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isLongPressActive = useRef<boolean>(false);

  // Notifiche Custom
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };

  // Aggiorna l'updatedAt locale in memoria ogni volta che l'utente effettua modifiche a piante, attività, tracciatori o impostazioni
  useEffect(() => {
    if (!isReadOnlyMode && isCloudLoaded) {
      const nowStr = new Date().toISOString();
      setState(prev => {
        if (prev.updatedAt === nowStr) return prev;
        return {
          ...prev,
          updatedAt: nowStr
        };
      });
    }
  }, [state.plants, state.activities, state.smartTrackers, state.settings, isReadOnlyMode, isCloudLoaded]);

  // Auto-salvataggio nel localStorage
  useEffect(() => {
    if (!isReadOnlyMode && isCloudLoaded) {
      localStorage.setItem("flora_journal_db", JSON.stringify(state));
    }
  }, [state, isReadOnlyMode, isCloudLoaded]);

  useEffect(() => {
    if (selectedPlantId && !isReadOnlyMode) {
      localStorage.setItem("flora_selected_plant_id", selectedPlantId);
    }
    // Chiudi la schermata Note Salvate quando l'utente cambia pianta selezionata
    setIsSavedNotesViewOpen(false);
  }, [selectedPlantId, isReadOnlyMode]);

  // Salvataggio automatico dei dati parziali dei form per evitare perdite se l'utente esce dall'app
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("flora_new_tracker_form", JSON.stringify(newTrackerForm));
    }
  }, [newTrackerForm]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("flora_new_activity_form", JSON.stringify(newActivityForm));
    }
  }, [newActivityForm]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("flora_new_plant_form", JSON.stringify(newPlantForm));
    }
  }, [newPlantForm]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("flora_new_diary_form", JSON.stringify(newDiaryForm));
    }
  }, [newDiaryForm]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      if (editingItem) {
        localStorage.setItem("flora_editing_item", JSON.stringify(editingItem));
      } else {
        localStorage.removeItem("flora_editing_item");
      }
    }
  }, [editingItem]);

  // Persistenza stato modali/dialoghi di input
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("flora_is_add_plant_open", String(isAddPlantOpen));
    }
  }, [isAddPlantOpen]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("flora_is_edit_plant_open", String(isEditPlantOpen));
    }
  }, [isEditPlantOpen]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("flora_is_new_diary_open", String(isNewDiaryOpen));
    }
  }, [isNewDiaryOpen]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("flora_is_settings_open", String(isSettingsOpen));
    }
  }, [isSettingsOpen]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("flora_is_add_activity_open", String(isAddActivityOpen));
    }
  }, [isAddActivityOpen]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("flora_is_agenda_open", String(isAgendaOpen));
    }
  }, [isAgendaOpen]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("flora_is_history_open", String(isHistoryOpen));
    }
  }, [isHistoryOpen]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("flora_is_add_tracker_open", String(isAddTrackerOpen));
    }
  }, [isAddTrackerOpen]);

  // A. PWA Handler: Cattura la richiesta di installazione prima del caricamento sulla homepage
  useEffect(() => {
    const handleBeforePrompt = (e: any) => {
      e.preventDefault();
      setPwaPrompt(e);
    };
    window.addEventListener("beforeinstallprompt", handleBeforePrompt);

    const handleAppInstalled = () => {
      setIsPwaInstalled(true);
      setPwaPrompt(null);
      showToast("Flora installata con successo sullo Schermo! 🌿📱");
    };
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforePrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  // A. Caricamento e Sincronizzazione Centralizzata (Cloud Database "samuel-garden")
  useEffect(() => {
    let isMounted = true;
    let unsubscribeFirestore: (() => void) | null = null;

    const initCloudSync = async () => {
      try {
        const { doc, getDoc, onSnapshot, setDoc } = await import("firebase/firestore");
        const { db } = await import("./firebase");

        const docRef = doc(db, "shares", "samuel-garden");

        if (isReadOnlyMode) {
          // MODALITÀ VISUALIZZATORE: Ascolto in tempo reale (onSnapshot) del diario centralizzato del cloud
          unsubscribeFirestore = onSnapshot(docRef, (docSnap) => {
            if (!isMounted) return;
            if (docSnap.exists()) {
              const parsedData = docSnap.data();
              if (parsedData && (parsedData.plants || parsedData.activities)) {
                captureInitialSeenIds(parsedData.plants || [], parsedData.activities || [], parsedData.updatedAt);
                setState(prev => {
                  // Evita re-render inutili se non ci sono novità di sostanza
                  if (JSON.stringify(prev.plants) === JSON.stringify(parsedData.plants) &&
                      JSON.stringify(prev.activities) === JSON.stringify(parsedData.activities) &&
                      JSON.stringify(prev.smartTrackers) === JSON.stringify(parsedData.smartTrackers)) {
                    return prev;
                  }
                  return {
                    plants: parsedData.plants || [],
                    activities: parsedData.activities || [],
                    smartTrackers: parsedData.smartTrackers || [],
                    settings: parsedData.settings || prev.settings,
                    updatedAt: parsedData.updatedAt
                  };
                });
              }
            }
            setIsCloudLoaded(true);
          }, (err) => {
            console.error("Errore Realtime Sync o permessi mancanti:", err);
            setIsCloudLoaded(true);
          });
        } else {
          // MODALITÀ EDITOR: Caricamento asincrono singolo (one-shot) all'avvio per non disturbare la digitazione dell'editor
          try {
            const docSnap = await getDoc(docRef);
            if (!isMounted) return;

            if (docSnap.exists()) {
              const parsedData = docSnap.data();
              if (parsedData && (parsedData.plants || parsedData.activities)) {
                const cloudUpdatedAt = parsedData.updatedAt || "";
                
                // Leggi fresco da localStorage per evitare scope closures obsolete di React
                let localUpdatedAt = "";
                try {
                  const savedRaw = localStorage.getItem("flora_journal_db");
                  if (savedRaw) {
                    const parsedSaved = JSON.parse(savedRaw);
                    localUpdatedAt = parsedSaved.updatedAt || "";
                  }
                } catch (_) {}

                if (localUpdatedAt && localUpdatedAt > cloudUpdatedAt) {
                  console.log("Lo stato locale è PIÙ RECENTE di quello sul Cloud. Conservo ed effettuo sync in salita!");
                } else {
                  console.log("Caricamento dello stato aggiornato del Cloud in corso...");
                  setState({
                    plants: parsedData.plants || [],
                    activities: parsedData.activities || [],
                    smartTrackers: parsedData.smartTrackers || [],
                    settings: parsedData.settings || { userName: "Samuel", gardenName: "Orto Botanico di Samuel", offlineMode: false },
                    updatedAt: cloudUpdatedAt
                  });
                  if (parsedData.plants && parsedData.plants.length > 0) {
                    setSelectedPlantId(parsedData.plants[0].id);
                  }
                }
              }
            } else {
              // Crea di default se non esiste ancora
              const initialState = getInitialState();
              const now = new Date().toISOString();
              await setDoc(docRef, sanitizeFirestorePayload({
                ...initialState,
                id: "samuel-garden",
                updatedAt: now
              }));
              setState({ ...initialState, updatedAt: now });
            }
          } catch (getErr) {
            console.error("Errore lettura iniziale Editor:", getErr);
          } finally {
            if (isMounted) {
              setIsCloudLoaded(true);
            }
          }
        }
      } catch (err) {
        console.warn("Connessione Firestore o caricamento asincrono fallito, uso offline fallback:", err);
        if (isMounted) {
          setIsCloudLoaded(true);
        }
      }
    };

    setIsCloudLoaded(false); // Resetta isCloudLoaded per evitare conflitti o salvataggi asincroni durante il cambio di stato della connessione!
    initCloudSync();

    return () => {
      isMounted = false;
      if (unsubscribeFirestore) {
        unsubscribeFirestore();
      }
    };
  }, [isReadOnlyMode]);

  // B. Autosave Editor: Salva in tempo reale su Firestore (con debounce) ogni volta che l'editor compie modifiche
  useEffect(() => {
    if (isReadOnlyMode) return;
    if (!isCloudLoaded) return; // Non sovrascrivere MAI il cloud prima che il caricamento iniziale sia avvenuto con successo!

    const timer = setTimeout(async () => {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        const { db } = await import("./firebase");

        const docRef = doc(db, "shares", "samuel-garden");

        // Prima compattiamo ricorsivamente le immagini
        const compressedState = await compressStateImages(state);
        
        // Se si è verificata una compressione di immagini nuove pesanti, allineiamo lo stato React locale
        if (JSON.stringify(compressedState.plants) !== JSON.stringify(state.plants)) {
          setState(compressedState);
        }

        const payload = {
          id: "samuel-garden",
          plants: compressedState.plants,
          activities: compressedState.activities,
          smartTrackers: compressedState.smartTrackers || [],
          settings: compressedState.settings,
          updatedAt: state.updatedAt || new Date().toISOString()
        };

        // Salva direttamente su Firestore, igienizzato contro chiavi undefined
        await setDoc(docRef, sanitizeFirestorePayload(payload), { merge: true });
        console.log("Diario centralizzato salvato perfettamente sul cloud (Firestore)!");
      } catch (err) {
        console.error("Errore salvataggio automatico sul cloud:", err);
      }
    }, 2000); // 2 secondi di debounce per ottimizzare le performance

    return () => clearTimeout(timer);
  }, [state, isReadOnlyMode, isCloudLoaded]);

  // Compressione automatica in background all'avvio per sanare vecchi dati pesanti presenti nel localStorage
  useEffect(() => {
    if (!isCloudLoaded || isReadOnlyMode) return;
    const runDeferredCompression = async () => {
      try {
        const compressed = await compressStateImages(state);
        if (JSON.stringify(compressed.plants) !== JSON.stringify(state.plants)) {
          console.log("Compressione automatica iniziale di recupero eseguita su vecchi dati pesanti!");
          setState(compressed);
        }
      } catch (e) {
        console.error("Errore compressione iniziale background:", e);
      }
    };
    // Esegui con un soffio di ritardo per non bloccare l'interfaccia
    const t = setTimeout(runDeferredCompression, 1000);
    return () => clearTimeout(t);
  }, [isCloudLoaded, isReadOnlyMode]);

  // Filtro piante vive e morte
  const activePlants = state.plants.filter(p => p.isDead !== true);
  const deadPlants = state.plants.filter(p => p.isDead === true);

  // Pianta attualmente selezionata (può essere una morta se selezionata esplicitamente dal memoriale, altrimenti la prima attiva)
  const selectedPlant = state.plants.find(p => p.id === selectedPlantId) || activePlants[0];

  const calculateAge = (startDateStr: string): number => {
    const start = new Date(startDateStr);
    const today = new Date();
    const diffTime = Math.abs(today.getTime() - start.getTime());
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  };

  const calculateAgeAtDate = (startDateStr: string, pastDateStr: string): number => {
    const start = new Date(startDateStr.split("T")[0]);
    const past = new Date(pastDateStr.split("T")[0]);
    const diffTime = past.getTime() - start.getTime();
    return Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
  };

  const movePlant = (plantId: string, direction: "up" | "down") => {
    if (isReadOnlyMode) return;
    const activeIndex = filteredPlants.findIndex(p => p.id === plantId);
    if (activeIndex === -1) return;

    const swapWithActiveIndex = direction === "up" ? activeIndex - 1 : activeIndex + 1;
    if (swapWithActiveIndex < 0 || swapWithActiveIndex >= filteredPlants.length) {
      showToast(direction === "up" ? "La pianta è già in cima! 🌿" : "La pianta è già in fondo! 🌿");
      return;
    }

    const targetPlantId = filteredPlants[swapWithActiveIndex].id;

    setState(prev => {
      const plants = [...prev.plants];
      const idx1 = plants.findIndex(p => p.id === plantId);
      const idx2 = plants.findIndex(p => p.id === targetPlantId);
      if (idx1 === -1 || idx2 === -1) return prev;

      // Swap position of plants in state
      const temp = plants[idx1];
      plants[idx1] = plants[idx2];
      plants[idx2] = temp;

      return {
        ...prev,
        plants
      };
    });
    showToast(direction === "up" ? "Pianta spostata in alto ⬆️" : "Pianta spostata in basso ⬇️");
  };

  // --- TRASFORMAZIONE FILE IN BASE64 PER RENDERE L'HTML COMPILATO STANDALONE INTEGRALE ---
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files[0]) {
      processFile(files[0]);
    }
  };

  const processFile = async (file: File) => {
    showToast("Compressione e ottimizzazione dell'immagine... 🖼️⚡");
    try {
      const compressedBase64 = await compressFile(file, 500, 0.5);
      setNewPlantForm(prev => ({ ...prev, imageUrl: compressedBase64 }));
      showToast("Immagine catturata e ottimizzata correttamente! 🌿");
    } catch (err) {
      console.error("Errore lettura immagine:", err);
      showToast("Immagine non caricata correttamente.");
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files[0]) {
      processFile(files[0]);
    }
  };

  const handleEditFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files[0]) {
      processFile(files[0]);
    }
  };

  const handleEditDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingEdit(true);
  };

  const handleEditDragLeave = () => {
    setIsDraggingEdit(false);
  };

  const handleEditDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingEdit(false);
    const files = e.dataTransfer.files;
    if (files && files[0]) {
      processFile(files[0]);
    }
  };

  // --- OPERAZIONI DI STATO PER PIANTE ---
  const handleCreatePlant = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlantForm.name || !newPlantForm.nickname) {
      showToast("Compila almeno il nome e il soprannome.");
      return;
    }

    const defaultImages = [
      "https://images.unsplash.com/photo-1545241047-6083a3684587?auto=format&fit=crop&q=80&w=800",
      "https://images.unsplash.com/photo-1599599810769-bcde5a160d32?auto=format&fit=crop&q=80&w=800",
      "https://images.unsplash.com/photo-1501004318641-724e63f7664c?auto=format&fit=crop&q=80&w=800"
    ];

    const finalPlant: Plant = {
      id: "plant-" + Date.now(),
      name: newPlantForm.name,
      nickname: newPlantForm.nickname,
      species: newPlantForm.species || "Specie Sconosciuta",
      origin: newPlantForm.origin || PlantOrigin.ACQUISTO,
      startDate: newPlantForm.startDate || new Date().toISOString().split("T")[0],
      description: newPlantForm.description || "Nessun racconto di crescita iniziale inserito.",
      imageUrl: newPlantForm.imageUrl || defaultImages[Math.floor(Math.random() * defaultImages.length)],
      status: newPlantForm.status || PlantStatus.CRESCITA,
      health: newPlantForm.health || 100,
      notes: newPlantForm.notes || "",
      tags: newPlantForm.tags || [],
      diary: [
        {
          id: "log-" + Date.now(),
          date: new Date().toISOString(),
          eventTitle: "Aggiunta del diario",
          notes: "Apertura ufficiale delle osservazioni e del diario di crescita in Flora.",
          category: "creazione"
        }
      ]
    };

    setState(prev => ({
      ...prev,
      plants: [finalPlant, ...prev.plants]
    }));

    setSelectedPlantId(finalPlant.id);
    setIsAddPlantOpen(false);
    setNewPlantForm({
      name: "",
      nickname: "",
      species: "",
      origin: PlantOrigin.ACQUISTO,
      startDate: new Date().toISOString().split("T")[0],
      description: "",
      imageUrl: "",
      status: PlantStatus.CRESCITA,
      health: 90,
      notes: "",
      tags: []
    });
    showToast(`Registrato diario di ${finalPlant.nickname} con successo!`);
  };

  const handleEditPlant = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPlant) return;

    setState(prev => ({
      ...prev,
      plants: prev.plants.map(p => {
        if (p.id === selectedPlant.id) {
          return {
            ...p,
            name: newPlantForm.name || p.name,
            nickname: newPlantForm.nickname || p.nickname,
            species: newPlantForm.species || p.species,
            origin: newPlantForm.origin || p.origin,
            startDate: newPlantForm.startDate || p.startDate,
            description: newPlantForm.description || p.description,
            imageUrl: newPlantForm.imageUrl || p.imageUrl,
            status: newPlantForm.status || p.status,
            health: newPlantForm.health ?? p.health,
            notes: newPlantForm.notes || p.notes,
            tags: newPlantForm.tags || p.tags
          };
        }
        return p;
      })
    }));

    setIsEditPlantOpen(false);
    showToast(`Aggiornato ${selectedPlant.nickname} nel diario core.`);
  };

  const handleEditPlantAndStoricize = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPlant) return;

    const ageDays = calculateAge(newPlantForm.startDate || new Date().toISOString().split("T")[0]);
    const summaryNotes = `Dati storicizzati al ${new Date().toLocaleDateString("it-IT")}:\n• Salute: ${newPlantForm.health ?? selectedPlant.health}%\n• Stato: ${newPlantForm.status ?? selectedPlant.status}\n• Età: ${ageDays} giorni\n• Descrizione: ${newPlantForm.description || "Nessuna descrizione."}\n• Origine: ${newPlantForm.origin || selectedPlant.origin}`;

    const snapEntry: DiaryEntry = {
      id: "diary-snap-" + Date.now(),
      date: new Date().toISOString(),
      eventTitle: `Memoria Storica: ${newPlantForm.nickname || selectedPlant.nickname}`,
      notes: summaryNotes,
      imageUrl: newPlantForm.imageUrl || selectedPlant.imageUrl,
      category: "evoluzione"
    };

    setState(prev => ({
      ...prev,
      plants: prev.plants.map(p => {
        if (p.id === selectedPlant.id) {
          return {
            ...p,
            name: newPlantForm.name || p.name,
            nickname: newPlantForm.nickname || p.nickname,
            species: newPlantForm.species || p.species,
            origin: newPlantForm.origin || p.origin,
            startDate: newPlantForm.startDate || p.startDate,
            description: newPlantForm.description || p.description,
            imageUrl: newPlantForm.imageUrl || p.imageUrl,
            status: newPlantForm.status || p.status,
            health: newPlantForm.health ?? p.health,
            notes: newPlantForm.notes || p.notes,
            tags: newPlantForm.tags || p.tags,
            diary: [snapEntry, ...(p.diary || [])]
          };
        }
        return p;
      })
    }));

    setIsEditPlantOpen(false);
    showToast(`Aggiornato ${selectedPlant.nickname} e registrata una nuova tappa storica con successo! 📜🌿`);
  };

  const handleDuplicatePlant = (plantId: string) => {
    const originalPlant = state.plants.find(p => p.id === plantId);
    if (!originalPlant) return;

    const newPlantId = "plant-copy-" + Date.now();
    const newNickname = `${originalPlant.nickname} (Copia)`;
    
    // Duplica le note del diario con nuovi ID univoci
    const duplicatedDiary = (originalPlant.diary || []).map(entry => ({
      ...entry,
      id: "diary-copy-" + Math.random().toString(36).substr(2, 9) + "-" + Date.now()
    }));

    // Duplica le note salvate con nuovi ID univoci
    const duplicatedSavedNotes = (originalPlant.savedNotes || []).map(note => ({
      ...note,
      id: "note-copy-" + Math.random().toString(36).substr(2, 9) + "-" + Date.now()
    }));

    // Costruisce la pianta duplicata
    const duplicatedPlant: Plant = {
      ...originalPlant,
      id: newPlantId,
      nickname: newNickname,
      diary: duplicatedDiary,
      savedNotes: duplicatedSavedNotes,
      startDate: originalPlant.startDate || new Date().toISOString().split("T")[0]
    };

    // Trova e duplica le attività collegate nell'agenda
    const originalActivities = state.activities.filter(a => a.plantId === plantId);
    const duplicatedActivities = originalActivities.map(act => ({
      ...act,
      id: "activity-copy-" + Math.random().toString(36).substr(2, 9) + "-" + Date.now(),
      plantId: newPlantId
    }));

    setState(prev => ({
      ...prev,
      plants: [duplicatedPlant, ...prev.plants],
      activities: [...prev.activities, ...duplicatedActivities]
    }));

    setSelectedPlantId(newPlantId);
    showToast(`Pianta "${originalPlant.nickname}" copiata con successo come "${newNickname}" con tutte le note e compiti! 🌿✨`);
  };

  const handleOpenEdit = () => {
    if (!selectedPlant) return;
    setNewPlantForm({
      name: selectedPlant.name,
      nickname: selectedPlant.nickname,
      species: selectedPlant.species,
      origin: selectedPlant.origin,
      startDate: selectedPlant.startDate,
      description: selectedPlant.description,
      imageUrl: selectedPlant.imageUrl,
      status: selectedPlant.status,
      health: selectedPlant.health,
      notes: selectedPlant.notes,
      tags: selectedPlant.tags
    });
    setIsEditPlantOpen(true);
  };

  const handleDeletePlant = (plantId: string) => {
    setPlantIdToDelete(plantId);
  };

  const handleDeclareDeath = (plantId: string, notes: string) => {
    setState(prev => {
      const updatedPlants = prev.plants.map(p => {
        if (p.id === plantId) {
          const finalDiaryEntry: DiaryEntry = {
            id: "diary-death-" + Date.now(),
            date: new Date().toISOString(),
            eventTitle: "Addio a " + p.name,
            notes: notes || "La pianta purtroppo ci ha lasciato. Conservata con affetto nel memoriale botanico.",
            category: "evoluzione"
          };
          return {
            ...p,
            isDead: true,
            deathDate: new Date().toISOString(),
            deathNotes: notes || "Nessun ultimo saluto o nota aggiuntiva.",
            health: 0,
            diary: [finalDiaryEntry, ...p.diary]
          };
        }
        return p;
      });
      return { ...prev, plants: updatedPlants };
    });

    // Seleziona un'altra pianta ancora in vita
    const remainingActive = state.plants.filter(p => p.id !== plantId && !p.isDead);
    if (remainingActive.length > 0) {
      setSelectedPlantId(remainingActive[0].id);
    } else {
      setSelectedPlantId("");
    }

    showToast("Addio registrato con successo nel memoriale. 🌿🖤");
  };

  const handleRevivePlant = (plantId: string) => {
    setState(prev => {
      const updatedPlants = prev.plants.map(p => {
        if (p.id === plantId) {
          const reviveEntry: DiaryEntry = {
            id: "diary-revive-" + Date.now(),
            date: new Date().toISOString(),
            eventTitle: "Ritorno in cura attiva",
            notes: "La pianta è stata ripristinata e riportata alla serra attiva dell'erbario!",
            category: "evoluzione"
          };
          return {
            ...p,
            isDead: false,
            deathDate: undefined,
            deathNotes: undefined,
            health: 40, // Riparte da uno stato di recupero
            diary: [reviveEntry, ...p.diary]
          };
        }
        return p;
      });
      return { ...prev, plants: updatedPlants };
    });

    setSelectedPlantId(plantId);
    showToast("Riposizionata nella serra attiva! 🌿✨");
  };

  const formatLocalDate = (dateStr: string) => {
    try {
      const parts = dateStr.split("T")[0].split("-");
      if (parts.length === 3) {
        return `${parts[2]}/${parts[1]}`;
      }
    } catch (_) {}
    return dateStr;
  };

  const getEffectiveStartDate = (t: SmartTracker) => {
    const checkIns = t.checkIns || [];
    const todayStr = new Date().toISOString().split("T")[0];
    
    if (checkIns.length === 0) {
      return todayStr;
    }
    
    const sortedCheckIns = [...checkIns].sort();
    return sortedCheckIns[0];
  };

  const calculateTargetDate = (startDateStr: string, duration: number) => {
    try {
      const parts = startDateStr.split("-");
      let start: Date;
      if (parts.length === 3) {
        start = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 0, 0, 0, 0);
      } else {
        start = new Date(startDateStr + "T00:00:00");
      }
      const target = new Date(start.getTime() + duration * 24 * 60 * 60 * 1000);
      return target.toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" });
    } catch (e) {
      return "";
    }
  };

  const calculateElapsedDays = (t: SmartTracker) => {
    if (t.isCompleted) {
      return t.durationDays;
    }
    const checkIns = t.checkIns || [];
    const todayStr = new Date().toISOString().split("T")[0];
    const pastCheckedCount = checkIns.filter(d => d < todayStr).length;
    return Math.min(t.durationDays, pastCheckedCount + 1);
  };

  const handleAddSmartTracker = (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnlyMode) {
      showToast("La serra è in sola lettura. Impossibile attivare tracciatori. 🌿");
      return;
    }
    if (!newTrackerForm.title.trim()) {
      showToast("Inserisci un titolo per il tracciamento!");
      return;
    }
    const newTracker: SmartTracker = {
      id: "tracker-" + Date.now(),
      title: newTrackerForm.title,
      startDate: newTrackerForm.startDate,
      durationDays: Number(newTrackerForm.durationDays) || 1,
      isCompleted: false,
      notes: newTrackerForm.notes,
      checkIns: []
    };
    setState(prev => ({
      ...prev,
      smartTrackers: [newTracker, ...(prev.smartTrackers || [])]
    }));
    setIsAddTrackerOpen(false);
    setNewTrackerForm({
      title: "",
      startDate: new Date().toISOString().split("T")[0],
      durationDays: 21,
      notes: ""
    });
    showToast("Tracciatore intelligente attivato! ⏱️🌿");
  };

  const handleToggleTracker = (id: string) => {
    if (isReadOnlyMode) {
      showToast("La serra è in sola lettura. Modifiche disabilitate. 🌿");
      return;
    }
    const todayStr = new Date().toISOString().split("T")[0];
    setState(prev => {
      const updated = (prev.smartTrackers || []).map(t => {
        if (t.id === id) {
          const checkIns = t.checkIns ? [...t.checkIns] : [];
          let isCompleted = t.isCompleted;
          let completedAt = t.completedAt;

          if (checkIns.includes(todayStr)) {
            // Rimuovi check-in di oggi (sblocca)
            const index = checkIns.indexOf(todayStr);
            if (index > -1) {
              checkIns.splice(index, 1);
            }
            isCompleted = false;
            completedAt = undefined;
          } else {
            // Aggiungi check-in di oggi (ferma e avanza)
            if (!checkIns.includes(todayStr)) {
              checkIns.push(todayStr);
            }
            if (checkIns.length >= t.durationDays) {
              isCompleted = true;
              completedAt = new Date().toISOString();
            }
          }

          return {
            ...t,
            checkIns,
            isCompleted,
            completedAt
          };
        }
        return t;
      });
      return { ...prev, smartTrackers: updated };
    });
    showToast("Tracciatore aggiornato.");
  };

  const handleDeleteTracker = (id: string) => {
    if (isReadOnlyMode) {
      showToast("La serra è in sola lettura. Cancellazione disabilitata. 🌿");
      return;
    }
    setState(prev => ({
      ...prev,
      smartTrackers: (prev.smartTrackers || []).filter(t => t.id !== id)
    }));
    showToast("Tracciatore eliminato.");
  };

  const handleAddGlobalActivity = (title: string, priority: "bassa" | "media" | "alta", dueDate: string) => {
    if (isReadOnlyMode) {
      showToast("La serra è in sola lettura. Attività disabilitate. 🌿");
      return;
    }
    if (!title.trim()) return;
    const newAct: CareActivity = {
      id: "act-global-" + Date.now(),
      plantId: "global",
      type: "generale",
      title: title,
      status: "todo",
      dueDate: dueDate || new Date().toISOString().split("T")[0],
      priority: priority
    };
    setState(prev => ({
      ...prev,
      activities: [newAct, ...prev.activities]
    }));
    showToast("Attività botanica aggiunta in Agenda!");
  };

  const handleDeleteGlobalActivity = (id: string) => {
    if (isReadOnlyMode) {
      showToast("La serra è in sola lettura. Modifiche disabilitate. 🌿");
      return;
    }
    setState(prev => ({
      ...prev,
      activities: prev.activities.filter(act => act.id !== id)
    }));
    showToast("Faccenda rimossa definitivamente.");
  };

  const handleDeleteDiaryEntry = (plantId: string, entryId: string) => {
    if (isReadOnlyMode) {
      showToast("La serra è in sola lettura. Modifiche disabilitate. 🌿");
      return;
    }
    setState(prev => ({
      ...prev,
      plants: prev.plants.map(p => {
        if (p.id === plantId) {
          return {
            ...p,
            diary: (p.diary || []).filter(d => d.id !== entryId)
          };
        }
        return p;
      })
    }));
    showToast("Voce della cronologia eliminata definitivamente. 📒");
  };

  const moveDiaryEntry = (entryId: string, plantId: string, direction: "up" | "down") => {
    if (isReadOnlyMode) return;
    setState(prev => {
      const updatedPlants = prev.plants.map(p => {
        if (p.id !== plantId) return p;
        const diary = [...(p.diary || [])];
        const index = diary.findIndex(d => d.id === entryId);
        if (index === -1) return p;

        const targetIndex = direction === "up" ? index - 1 : index + 1;
        if (targetIndex >= 0 && targetIndex < diary.length) {
          // Swap
          const temp = diary[index];
          diary[index] = diary[targetIndex];
          diary[targetIndex] = temp;
        }
        return {
          ...p,
          diary
        };
      });
      return {
        ...prev,
        plants: updatedPlants
      };
    });
    showToast("Posizione della nota modificata. 📒↕️");
  };

  const startEditDiary = (entryId: string, plantId: string) => {
    if (isReadOnlyMode) {
      showToast("La serra è in sola lettura. Modifiche disabilitate. 🌿");
      return;
    }
    const plant = state.plants.find(p => p.id === plantId);
    const entry = plant?.diary?.find(d => d.id === entryId);
    if (entry) {
      setEditingItem({
        id: entry.id,
        parentPlantId: plantId,
        type: "diary",
        title: entry.eventTitle,
        notes: entry.notes,
        category: entry.category,
        imageUrl: entry.imageUrl,
        date: entry.date
      });
    }
  };

  const startEditActivity = (actId: string, isCompleted: boolean) => {
    if (isReadOnlyMode) {
      showToast("La serra è in sola lettura. Modifiche disabilitate. 🌿");
      return;
    }
    const act = state.activities.find(a => a.id === actId);
    if (act) {
      setEditingItem({
        id: act.id,
        type: isCompleted ? "completed-activity" : "activity",
        title: act.title,
        activityType: act.type,
        priority: act.priority,
        dueDate: act.dueDate
      });
    }
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnlyMode) {
      showToast("La serra è in sola lettura. Modifiche disabilitate. 🌿");
      return;
    }
    if (!editingItem) return;

    if (editingItem.type === "diary") {
      if (!editingItem.title.trim() || !editingItem.notes?.trim()) {
        showToast("Inserisci titolo e testo della nota.");
        return;
      }
      setState(prev => ({
        ...prev,
        plants: prev.plants.map(p => {
          if (p.id === editingItem.parentPlantId) {
            const updatedDiary = (p.diary || []).map(d => {
              if (d.id === editingItem.id) {
                return {
                  ...d,
                  eventTitle: editingItem.title,
                  notes: editingItem.notes || "",
                  category: (editingItem.category || d.category) as DiaryEntry["category"],
                  imageUrl: editingItem.imageUrl,
                  date: editingItem.date || d.date
                };
              }
              return d;
            });
            // Auto-sort by date descending!
            updatedDiary.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
            return {
              ...p,
              diary: updatedDiary
            };
          }
          return p;
        })
      }));
      showToast("Nota del diario botanico salvata con successo! 📒");
    } else {
      if (!editingItem.title.trim()) {
        showToast("Inserisci un titolo per l'attività.");
        return;
      }
      setState(prev => ({
        ...prev,
        activities: prev.activities.map(act => {
          if (act.id === editingItem.id) {
            return {
              ...act,
              title: editingItem.title,
              priority: (editingItem.priority || act.priority) as CareActivity["priority"],
              dueDate: editingItem.dueDate || act.dueDate,
              type: editingItem.activityType || act.type
            };
          }
          return act;
        })
      }));
      showToast("Attività botanica aggiornata correttamente! 🗓️");
    }

    setEditingItem(null);
  };

  // Funzioni helper per la gestione degli eventi di Pressione Prolungata (Long Press)
  const handleLongPressStart = (
    e: React.MouseEvent | React.TouchEvent,
    id: string,
    type: "activity" | "diary" | "completed-activity",
    title: string,
    parentPlantId?: string
  ) => {
    if (isReadOnlyMode) return;
    isLongPressActive.current = false;

    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
    }

    longPressTimerRef.current = setTimeout(() => {
      isLongPressActive.current = true;
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate(40); // Piccolo feedback aptico sui dispositivi mobili supportati
      }
      setDeleteConfirmItem({ id, type, title, parentPlantId });
    }, 700);
  };

  const handlePlantLongPressStart = (
    e: React.MouseEvent | React.TouchEvent,
    plant: Plant
  ) => {
    if (isReadOnlyMode) return;
    isLongPressActive.current = false;

    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
    }

    longPressTimerRef.current = setTimeout(() => {
      isLongPressActive.current = true;
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate(40);
      }
      setLongPressedPlant(plant);
    }, 700);
  };

  const handleLongPressEnd = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleElementClick = (e: React.MouseEvent | React.TouchEvent, normalAction: () => void) => {
    if (isLongPressActive.current) {
      e.preventDefault();
      e.stopPropagation();
      setTimeout(() => {
        isLongPressActive.current = false;
      }, 50);
      return;
    }
    normalAction();
  };

  const handleAddCustomActivity = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newActivityForm.title.trim()) {
      showToast("Inserisci un titolo per l'attività.");
      return;
    }
    if (!selectedPlantId) {
      showToast("Nessuna pianta selezionata.");
      return;
    }

    const newAct: CareActivity = {
      id: "act-" + Date.now(),
      plantId: selectedPlantId,
      type: newActivityForm.type,
      title: newActivityForm.title,
      status: "todo",
      dueDate: newActivityForm.dueDate || new Date().toISOString().split("T")[0],
      priority: newActivityForm.priority
    };

    setState(prev => ({
      ...prev,
      activities: [newAct, ...prev.activities]
    }));

    setIsAddActivityOpen(false);
    setNewActivityForm({
      title: "",
      type: "generale",
      priority: "media",
      dueDate: new Date().toISOString().split("T")[0]
    });
    showToast("Nuovo dovere inserito nel calendario.");
  };

  // --- REGISTRAZIONE DIARIO DI CRESCITA ---
  const handleAddDiaryEntry = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDiaryForm.eventTitle || !newDiaryForm.notes) {
      showToast("Inserisci un titolo e il testo della nota.");
      return;
    }

    const newEntry: DiaryEntry = {
      id: "diary-" + Date.now(),
      date: newDiaryForm.date || new Date().toISOString(),
      eventTitle: newDiaryForm.eventTitle,
      notes: newDiaryForm.notes,
      imageUrl: newDiaryForm.imageUrl || undefined,
      category: newDiaryForm.category
    };

    setState(prev => ({
      ...prev,
      plants: prev.plants.map(p => {
        if (p.id === selectedPlantId) {
          const updatedDiary = [newEntry, ...(p.diary || [])];
          updatedDiary.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
          return {
            ...p,
            diary: updatedDiary
          };
        }
        return p;
      })
    }));

    // Se la categoria era un'azione specifica, possiamo incrementare la salute o registrare l'attività compleata
    setIsNewDiaryOpen(false);
    setNewDiaryForm({
      eventTitle: "",
      notes: "",
      imageUrl: "",
      category: "osservazione",
      date: new Date().toISOString()
    });
    showToast("Splendido momento aggiunto alla timeline!");
  };

  const handleDiaryFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files[0]) {
      showToast("Compressione e caricamento foto nota... 🖼️⚡");
      try {
        const compressedBase64 = await compressFile(files[0], 500, 0.5);
        setNewDiaryForm(prev => ({ ...prev, imageUrl: compressedBase64 }));
        showToast("Immagine della nota salvata e ottimizzata!");
      } catch (err) {
        console.error("Errore lettura immagine nota:", err);
        showToast("Immagine della nota non caricata.");
      }
    }
  };

  // --- CURA ATTIVITÀ ---
  const handleToggleActivity = (activityId: string) => {
    if (isReadOnlyMode) {
      showToast("La serra è in sola lettura. Impossibile modificare l'agenda. 🌿");
      return;
    }
    const act = state.activities.find(a => a.id === activityId);
    if (!act) return;

    const isCompleting = act.status === "todo";

    setState(prev => ({
      ...prev,
      activities: prev.activities.map(a => {
        if (a.id === activityId) {
          return {
            ...a,
            status: isCompleting ? "completed" : "todo",
            completedAt: isCompleting ? new Date().toISOString() : undefined,
            completedNotes: isCompleting ? "Azione spuntata dall'elenco rapido Flora." : undefined
          };
        }
        return a;
      }),
      plants: prev.plants.map(p => {
        if (p.id === act.plantId && isCompleting) {
          // Quando completiamo un'azione, aggiungiamo una nota automatica al diario di crescita e rinvigoriamo la salute!
          const newE: DiaryEntry = {
            id: "auto-act-" + Date.now(),
            date: new Date().toISOString(),
            eventTitle: `Svolta Attività: ${act.title}`,
            notes: "Attività completata da calendario dei doveri botanici.",
            category: act.type as any
          };
          return {
            ...p,
            health: Math.min(100, p.health + 5),
            diary: [newE, ...p.diary]
          };
        }
        return p;
      })
    }));

    showToast(isCompleting ? "Svolta registrata in memoria storica!" : "Attività riaperta.");
  };

  const handleCreateActivity = (type: CareActivity["type"], title: string, priority: CareActivity["priority"]) => {
    if (!selectedPlantId) return;
    const newAct: CareActivity = {
      id: "act-" + Date.now(),
      plantId: selectedPlantId,
      type: type,
      title: title,
      status: "todo",
      dueDate: new Date().toISOString().split("T")[0],
      priority: priority
    };

    setState(prev => ({
      ...prev,
      activities: [newAct, ...prev.activities]
    }));
    showToast("Nuovo promemoria aggiunto!");
  };

  // --- AI BOTANICAL CURATOR (SERVERSIDE GEMINI INTERGATION) ---
  const requestAiReview = async () => {
    if (!selectedPlant) return;
    setIsAiLoading(true);
    setAiAnalysis("");

    try {
      const recentLogs = selectedPlant.diary.slice(0, 3).map(d => `[${d.date.split("T")[0]}] ${d.eventTitle}: ${d.notes}`).join("\n");
      const activeActs = state.activities.filter(a => a.plantId === selectedPlant.id && a.status === "todo").map(a => a.title).join(", ");

      const response = await fetch(getApiUrl("/api/gemini/curator"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plant: selectedPlant,
          currentNotes: selectedPlant.notes,
          recentActivities: `Attività aperte: ${activeActs || "Nessuna"}\nDiario recente:\n${recentLogs}`
        })
      });

      if (!response.ok) {
        throw new Error("La chiamata al server ha restituito un errore.");
      }

      const data = await response.json();
      setAiAnalysis(data.text || "(Nessuna risposta generata)");
    } catch (e: any) {
      console.error(e);
      setAiAnalysis(`Il Curatore Botanico non è riuscito a connettersi: ${e.message}`);
    } finally {
      setIsAiLoading(false);
    }
  };

  // --- PORTABILITY DOWNLOAD EXPORTS ---
  const handleDownloadZIP = async () => {
    showToast("Preparazione e compressione dell'archivio ZIP... 🌿📦");
    try {
      const zip = new JSZip();
      zip.file("flora_journal_backup.json", JSON.stringify(state, null, 2));
      const blob = await zip.generateAsync({ type: "blob" });

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `flora_journal_backup_${new Date().toISOString().split('T')[0]}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      showToast("Dati della serra scaricati con successo in archivio .ZIP! 📦💾");
    } catch (e: any) {
      console.error(e);
      showToast("Errore durante l'esportazione ZIP. Riprova.");
    }
  };

  const handleUploadZIP = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    showToast("Lettura e scompattamento dell'archivio ZIP in corso... 📦⏳");
    try {
      const zip = new JSZip();
      const content = await zip.loadAsync(file);
      const backupFile = Object.keys(content.files).find(name => name.endsWith(".json"));
      if (!backupFile) {
        throw new Error("Nessun file JSON di backup trovato all'interno dello ZIP");
      }
      const jsonStr = await content.files[backupFile].async("text");
      const parsed = JSON.parse(jsonStr);

      if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.plants) || Array.isArray(parsed.activities)) {
          await importAndSync(parsed, "ZIP");
        } else {
          showToast("Il file ZIP non contiene una serra compatibile. ⚠️");
        }
      } else {
        showToast("Formato archivio non valido.");
      }
    } catch (err: any) {
      console.error(err);
      showToast("Errore durante il ripristino: " + err.message);
    } finally {
      e.target.value = "";
    }
  };

  const handleDownloadApp = async (format: "html" | "zip") => {
    showToast("Preparazione ed esportazione della tua serra digitale in corso...");
    try {
      const response = await fetch(getApiUrl(`/api/download-app?type=${format}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state)
      });

      if (!response.ok) {
        throw new Error("Errore durante la compilazione standalone");
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = format === "html" ? 'Flora_Diario_Botanico_Offline.html' : 'Flora_Build_Impianto.zip';
      a.click();
      window.URL.revokeObjectURL(url);
      showToast("Esportazione scaricata con successo! Perfetta offline.");
    } catch (err: any) {
      console.error(err);
      // Fallback Client-side puro se si esegue in hosting statico (ad Es. Vercel statico senza api backend)
      // Genera un file HTML autoprodotto che racchiude i dati correnti
      if (format === "html") {
        try {
          // Scarica una versione rudimentale ma funzionante di backup offline
          const dataJson = JSON.stringify(state);
          const localRestoreHtml = `<!DOCTYPE html>
<html lang="it">
<head>
    <meta charset="UTF-8">
    <title>Ripristino Archivio Botanico - Flora</title>
    <style>
      body { font-family: sans-serif; background-color: #fbfbf9; color: #2d3a2e; text-align: center; padding: 50px; }
      .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); border: 1px solid #e4e8e1; }
      h1 { font-family: Georgia, serif; color: #3c503e; }
      p { line-height: 1.6; }
      textarea { width: 100%; height: 200px; padding: 12px; border-radius: 6px; border: 1px solid #ccc; font-family: monospace; }
      .btn { display: inline-block; background-color: #506e53; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Flora: Backup di Emergenza</h1>
        <p>Questo file contiene l'intero stato congelato del tuo orto botanico. Puoi usarlo per copiare i tuoi dati o per ricaricarli in Flora tramite l'opzione Importa Stato.</p>
        <textarea readonly>${dataJson}</textarea>
        <p>Per caricare l'app completa sul tuo browser offline, aprilo dal server di sviluppo.</p>
        <a href="https://github.com" class="btn">Carica su GitHub</a>
    </div>
</body>
</html>`;
          const blobLocal = new Blob([localRestoreHtml], { type: "text/html" });
          const urlLocal = window.URL.createObjectURL(blobLocal);
          const aLocal = document.createElement('a');
          aLocal.href = urlLocal;
          aLocal.download = 'Flora_Backup_Dati.html';
          aLocal.click();
          showToast("Scaricato Backup Dati (Fallback statico).");
        } catch (localErr) {
          showToast("Impossibile generare l'esportazione.");
        }
      } else {
        showToast("L'esportazione ZIP richiede il server attivo.");
      }
    }
  };

  // --- CONDIVISIONE LINK COPIA STATO ---
  const handleCopyShareLink = async () => {
    // Calcola il dominio corretto in modo dinamico per supportare perfettamente Vercel, localhost e Google AI Studio
    const getCanonicalShareBaseUrl = (): string => {
      if (typeof window === "undefined") return "";
      const path = window.location.pathname.endsWith("/") ? window.location.pathname : window.location.pathname + "/";
      return `${window.location.protocol}//${window.location.host}${path}`;
    };

    const baseUrl = getCanonicalShareBaseUrl();
    setGeneratedShareUrl(baseUrl);
    setIsShareOpen(true);
    setIsCopiedSuccess(false);

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(baseUrl)
        .then(() => {
          setIsCopiedSuccess(true);
          showToast("Link unico del Diario Botanico copiato! 🌿✨");
        })
        .catch(() => {
          setIsCopiedSuccess(false);
          showToast("Impossibile copiare automaticamente. Puoi copiarlo direttamente dalla barra indirizzi del browser!");
        });
    } else {
      setIsCopiedSuccess(false);
    }
  };

  // Ripristina Orto e Ricarica presets
  const handleResetOrto = () => {
    if (confirm("Attenzione: questo azzererà tutte le modifiche e le foto tornando alle piante originarie di default. Procedere?")) {
      localStorage.removeItem("flora_journal_db");
      window.location.hash = "";
      window.location.reload();
    }
  };

  // --- INNESTO DI SICUREZZA FORZA SINCRONIZZAZIONE (RICHIESTA UTENTE) ---
  const handleForceDownload = async () => {
    setIsSyncing(true);
    setSyncStatusMessage("Scaricamento...");
    showToast("Scaricamento dei dati biologici dal database Cloud in corso... 📥🌱");
    try {
      const { doc, getDoc } = await import("firebase/firestore");
      const { db } = await import("./firebase");

      const docRef = doc(db, "shares", "samuel-garden");
      const docSnap = await getDoc(docRef);

      if (docSnap.exists()) {
        const parsedData = docSnap.data();
        if (parsedData && (parsedData.plants || parsedData.activities)) {
          if (!isReadOnlyMode) {
            const confirmOverwrite = window.confirm(
              "Attenzione: scaricare forzatamente i dati dal Cloud sovrascriverà tutte le modifiche non sincronizzate presenti su questo dispositivo. Continuare?"
            );
            if (!confirmOverwrite) {
              setIsSyncing(false);
              setSyncStatusMessage(null);
              return;
            }
          }

          captureInitialSeenIds(parsedData.plants || [], parsedData.activities || [], parsedData.updatedAt);
          
          setState({
            plants: parsedData.plants || [],
            activities: parsedData.activities || [],
            smartTrackers: parsedData.smartTrackers || [],
            settings: parsedData.settings || { userName: "Samuel", gardenName: "Orto Botanico di Samuel", offlineMode: false },
            updatedAt: parsedData.updatedAt || new Date().toISOString()
          });

          if (parsedData.plants && parsedData.plants.length > 0) {
            setSelectedPlantId(parsedData.plants[0].id);
          }

          showToast("Dati Cloud scaricati ed applicati con successo! 🌿✨");
        } else {
          showToast("Il documento Cloud esiste ma non contiene piante o attività. ⚠️");
        }
      } else {
        showToast("Nessun database centralizzato trovato sul Cloud per 'samuel-garden'. Verrà creato al primo salvataggio!");
      }
    } catch (err: any) {
      console.error("Errore caricamento manuale:", err);
      showToast("Errore di caricamento: " + err.message);
    } finally {
      setIsSyncing(false);
      setSyncStatusMessage(null);
    }
  };

  const handleForceUpload = async () => {
    if (isReadOnlyMode) {
      showToast("Sei in modalità Visualizzatore. Clicca 5 volte sullo status per diventare Editor e caricare!");
      return;
    }
    setIsSyncing(true);
    setSyncStatusMessage("Ottimizzazione...");
    showToast("Ottimizzazione immagini e caricamento forzato sul Cloud... 📤⚡");
    try {
      // Step 1: Comprime tutte le immagini dello stato per non superare mai il limite di 1MB di Firestore
      const compressedState = await compressStateImages(state);

      // Aggiorna lo stato React in memoria
      setState(compressedState);

      const { doc, setDoc } = await import("firebase/firestore");
      const { db } = await import("./firebase");

      const docRef = doc(db, "shares", "samuel-garden");
      const nowStr = new Date().toISOString();
      const payload = {
        id: "samuel-garden",
        plants: compressedState.plants,
        activities: compressedState.activities,
        smartTrackers: compressedState.smartTrackers || [],
        settings: compressedState.settings,
        updatedAt: nowStr
      };

      await setDoc(docRef, sanitizeFirestorePayload(payload), { merge: true });
      
      // Aggiorna anche l'updatedAt dello stato per evitare auto-scaricamenti conflittuali
      setState(prev => ({ ...prev, updatedAt: nowStr }));

      showToast("Tutti i dati e le immagini sono stati compressi e sincronizzati con successo sul Cloud! 🌿📤");
    } catch (err: any) {
      console.error("Errore salvataggio forzato:", err);
      showToast("Errore di sincronizzazione: " + err.message + ". Controlla le dimensioni dei file o la connessione.");
    } finally {
      setIsSyncing(false);
      setSyncStatusMessage(null);
    }
  };

  const importAndSync = async (parsedData: any, source: "ZIP" | "JSON") => {
    try {
      showToast("Analisi, compressione immagini ed applicazione backup... 🌿⚡");
      
      // Step 1: Comprime tutte le immagini del file di backup caricato
      const cleaned = await compressStateImages(parsedData);
      
      // Step 2: Carica in memoria locale
      setState(cleaned);
      if (cleaned.plants && cleaned.plants.length > 0) {
        setSelectedPlantId(cleaned.plants[0].id);
      }

      // Step 3: Se NON siamo in sola lettura (Reader), salviamo IMMEDIATAMENTE sul cloud senza aspettare 2s di debounce!
      if (!isReadOnlyMode) {
        setSyncStatusMessage("Backup in caricamento...");
        const { doc, setDoc } = await import("firebase/firestore");
        const { db } = await import("./firebase");
        const docRef = doc(db, "shares", "samuel-garden");
        
        const nowStr = new Date().toISOString();
        const payload = {
          id: "samuel-garden",
          plants: cleaned.plants,
          activities: cleaned.activities,
          smartTrackers: cleaned.smartTrackers || [],
          settings: cleaned.settings || { userName: "Samuel", gardenName: "Orto Botanico di Samuel", offlineMode: false },
          updatedAt: nowStr
        };

        await setDoc(docRef, sanitizeFirestorePayload(payload), { merge: true });
        
        // Sincronizza updatedAt locale in memoria
        setState(prev => ({ ...prev, updatedAt: nowStr }));
        showToast(`Caricamento ed ottimizzazione del backup ${source} sul database Cloud riusciti! 🎉🌿`);
      } else {
        showToast(`Backup ${source} applicato offline con successo. 🪴`);
      }
    } catch (err: any) {
      console.error("Errore durante importAndSync:", err);
      showToast("Errore di sincronizzazione o parsing: " + err.message);
    } finally {
      setSyncStatusMessage(null);
    }
  };

  // Gestione del click 5 volte per sbloccare o bloccare la modalità Editor/Visualizzatore
  const handleSyncPillClick = async () => {
    const nextClicks = syncClicks + 1;
    if (nextClicks >= 5) {
      setSyncClicks(0); // reset
      const nextReadOnly = !isReadOnlyMode;

      // Se stiamo passando da EDITOR a VISUALIZZATORE, salviamo IMMEDIATAMENTE per sicurezza per non perdere nulla
      if (nextReadOnly) {
        showToast("Salvataggio e consolidamento finale sul cloud... ⏳🌿");
        try {
          const { doc, setDoc } = await import("firebase/firestore");
          const { db } = await import("./firebase");
          const docRef = doc(db, "shares", "samuel-garden");
          const payload = {
            id: "samuel-garden",
            plants: state.plants,
            activities: state.activities,
            smartTrackers: state.smartTrackers || [],
            settings: state.settings,
            updatedAt: state.updatedAt || new Date().toISOString()
          };
          await setDoc(docRef, sanitizeFirestorePayload(payload), { merge: true });
          showToast("Salvataggio sincronizzato completato! ✨");
        } catch (saveErr) {
          console.error("Errore salvataggio di transizione:", saveErr);
        }
      }

      setIsReadOnlyMode(nextReadOnly);
      if (typeof window !== "undefined") {
        localStorage.setItem("flora_auth_mode", nextReadOnly ? "viewer" : "editor");
      }
      showToast(nextReadOnly ? "Modalità Visualizzatore Attivata 👁️ (Sola Lettura)" : "Modalità Editor Attivata! 🌿✏️");
    } else {
      setSyncClicks(nextClicks);
      showToast(`Clicca altre ${5 - nextClicks} volte per cambiare modalità! ⚙️`);
    }
  };

  // Tag helper
  const handleAddTag = () => {
    if (draftTag.trim() && !newPlantForm.tags?.includes(draftTag.trim())) {
      setNewPlantForm(prev => ({
        ...prev,
        tags: [...(prev.tags || []), draftTag.trim()]
      }));
      setDraftTag("");
    }
  };

  const handleRemoveTag = (t: string) => {
    setNewPlantForm(prev => ({
      ...prev,
      tags: prev.tags?.filter(tag => tag !== t) || []
    }));
  };

  // Genera tutti i tag unici presenti nel sistema per filtri (solo piante attive)
  const allTags = Array.from(new Set(activePlants.flatMap(p => p.tags || [])));

  // Filtraggio delle piante attive
  const filteredPlants = activePlants.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                          p.nickname.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          p.species.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = selectedStatusFilter === "all" || p.status === selectedStatusFilter;
    const matchesTag = selectedTagFilter === "all" || p.tags.includes(selectedTagFilter);
    return matchesSearch && matchesStatus && matchesTag;
  });

  if (!isCloudLoaded) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#fdfdfb] text-[#2d3a27] font-sans">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center gap-4 text-center max-w-sm px-6"
        >
          <div className="relative flex items-center justify-center">
            <div className="w-16 h-16 rounded-full border-4 border-[#e2e2d8] border-t-[#7e8c69] animate-spin"></div>
            <Sprout className="w-7 h-7 text-[#7e8c69] absolute animate-pulse" />
          </div>
          <div className="space-y-1.5 mt-2">
            <h3 className="font-serif italic text-[#2d3a27] text-lg font-semibold text-stone-800">Connessione alla Serra Cloud...</h3>
            <p className="text-xs text-stone-500 font-sans leading-relaxed">
              Sto caricando i dati biologici in tempo reale dal database centralizzato. Un istante di pazienza...
            </p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col font-sans select-none overflow-x-hidden antialiased text-[#2d3a27] bg-[#f5f5f0] p-4 lg:p-6 gap-6">
      
      <AnimatePresence>
        {isReadOnlyMode && showUpdatesMenu && (() => {
          const newPlants = getNewPlants();
          const newUpdates = getNewUpdates();
          const newActivities = getNewPendingActivities();
          const hasNewUpdates = newPlants.length > 0 || newUpdates.length > 0 || newActivities.length > 0;

          if (!hasNewUpdates) return null;

          return (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] bg-[#1e271a]/55 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto"
            >
              <motion.div
                initial={{ scale: 0.95, y: 15 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.95, y: 15 }}
                className="w-full max-w-4xl bg-[#fdfdfb] border-2 border-[#e2e2d8] rounded-[24px] shadow-2xl p-6 md:p-8 flex flex-col gap-6 my-8 max-h-[90vh] overflow-y-auto"
              >
                {/* HEADER DEL MENU */}
                <div className="flex flex-col gap-2 border-b border-[#e2e2d8] pb-5">
                  <div className="flex items-center gap-2">
                    <span className="text-[#2d3a27] bg-[#b2cfa5]/35 px-3 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase flex items-center gap-1">
                      <Sparkles className="w-3 h-3 text-[#2d3a27] animate-pulse" />
                      Menù degli Aggiornamenti d'Ingresso
                    </span>
                  </div>
                  <h2 className="text-2xl md:text-3xl font-serif italic text-[#2d3a27] font-semibold tracking-tight">
                    Novità nell'Orto Botanico
                  </h2>
                  <p className="text-xs text-sage-600 leading-relaxed max-w-2xl">
                    Benvenuto! Questa è la vista in tempo reale della serra condivisa di <strong>{state.settings.userName}</strong>. Di seguito trovi solo i nuovi contenuti inseriti o modificati dalla tua ultima visita.
                  </p>
                </div>

                {/* BENTO GRID DEGLI AGGIORNAMENTI (Se ce ne sono di nuovi) */}
                {hasNewUpdates ? (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    
                    {/* 1. SEZIONE NUOVE PIANTE CON PROVENIENZA ED ORIGINE COMPLETA */}
                    <div className="bg-white border border-[#e2e2d8] p-5 rounded-2xl flex flex-col gap-4 shadow-sm">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-[#2d3a27]/80 flex items-center gap-2 border-b border-stone-100 pb-2">
                        <Sprout className="w-4 h-4 text-[#7e8c69]" />
                        Nuove Piante Aggiunte
                      </h3>
                      
                      <div className="flex flex-col gap-3 overflow-y-auto pr-1">
                        {newPlants.length > 0 ? (
                          newPlants.map(p => (
                            <div key={p.id} className="flex items-center gap-3 p-2 hover:bg-stone-50 rounded-xl transition-all">
                              <img
                                src={p.imageUrl}
                                alt={p.nickname}
                                referrerPolicy="no-referrer"
                                className="w-10 h-10 rounded-full object-cover border border-[#e2e2d8] shrink-0"
                              />
                              <div className="min-w-0 flex-1">
                                <p className="text-xs font-semibold text-stone-900 truncate">
                                  {p.nickname}
                                </p>
                                <p className="text-[10px] text-stone-500 truncate italic">
                                  {p.species}
                                </p>
                              </div>
                          
                              <span className="text-[9px] px-2 py-0.5 rounded-full bg-sage-50 text-sage-700 font-mono font-bold shrink-0">
                                {p.origin}
                              </span>
                            </div>
                          ))
                        ) : (
                          <div className="text-center py-6 text-stone-400 text-xs italic">
                            Nessun nuovo eroe aggiunto di recente.
                          </div>
                        )}
                      </div>
                    </div>

                    {/* 2. CRONOLOGIA NOTE DI DIARIO RECENTI (QUALE PIANTA E' STATA MODIFICATA) */}
                    <div className="bg-white border border-[#e2e2d8] p-5 rounded-2xl flex flex-col gap-4 shadow-sm md:col-span-2">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-[#2d3a27]/80 flex items-center gap-2 border-b border-stone-100 pb-2">
                        <History className="w-4 h-4 text-[#d68a56]" />
                        Nuove Note & Piante Modificate
                      </h3>

                      <div className="flex flex-col gap-3 overflow-y-auto pr-1">
                        {newUpdates.length > 0 ? (
                          newUpdates.map(({ plant, entry }) => (
                            <div key={entry.id} className="p-3 bg-stone-50/60 rounded-xl border border-stone-100 flex flex-col gap-1.5 hover:bg-stone-50 transition-all">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-bold text-[#2d3a27] flex items-center gap-1 hover:underline cursor-pointer" onClick={() => {
                                  setSelectedPlantId(plant.id);
                                  handleMarkUpdatesAsSeen();
                                }}>
                                  🌱 {plant.nickname}
                                </span>
                                <span className="text-[10px] text-stone-400 font-mono shrink-0">
                                  {new Date(entry.date).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" })}
                                </span>
                              </div>
                              
                              <div className="pl-4 border-l-2 border-[#b2cfa5]">
                                <p className="text-xs font-semibold text-stone-800">
                                  {entry.eventTitle}
                                </p>
                                <p className="text-xs text-stone-600 line-clamp-2 mt-0.5 whitespace-pre-wrap leading-relaxed">
                                  {entry.notes}
                                </p>
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="text-center py-10 text-stone-400 text-xs italic">
                            Nessuna recente modifica o nota aggiunta.
                          </div>
                        )}
                      </div>
                    </div>

                    {/* 3. COSE NUOVE SCRITTE SULLE AGENDE / COMPITI PIANIFICATI */}
                    <div className="bg-white border border-[#e2e2d8] p-5 rounded-2xl flex flex-col gap-4 shadow-sm md:col-span-3">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-[#2d3a27]/80 flex items-center gap-2 border-b border-stone-100 pb-2">
                        <CalendarClock className="w-4 h-4 text-[#758461]" />
                        Nuovi Impegni in Agenda & Culti
                      </h3>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        {newActivities.length > 0 ? (
                          newActivities.map(act => {
                            const relPlant = state.plants.find(p => p.id === act.plantId);
                            const priorityColors = {
                              bassa: "bg-stone-100 text-stone-600",
                              media: "bg-amber-50 text-amber-700",
                              alta: "bg-rose-50 text-rose-700"
                            };
                            return (
                              <div key={act.id} className="p-3 bg-stone-50/40 rounded-xl border border-stone-100 flex flex-col justify-between gap-2 hover:bg-stone-50/70 transition-all">
                                <div>
                                  <div className="flex items-center justify-between gap-2 mb-1">
                                    <span className="text-[10px] font-mono text-stone-400 uppercase">
                                      {act.type}
                                    </span>
                                    <span className={`text-[9px] px-1.5 py-0.5 font-bold rounded-full uppercase ${priorityColors[act.priority]}`}>
                                      {act.priority}
                                    </span>
                                  </div>
                                  <p className="text-xs font-semibold text-stone-800 line-clamp-2">
                                    {act.title}
                                  </p>
                                  {relPlant && (
                                    <p className="text-[10px] text-sage-600 mt-1">
                                      Destinato a: <strong>{relPlant.nickname}</strong>
                                    </p>
                                  )}
                                </div>

                                <span className="text-[10px] font-mono text-emerald-800 font-bold bg-emerald-50/60 p-1 rounded text-center block mt-1">
                                  Scade il: {new Date(act.dueDate).toLocaleDateString("it-IT", { day: "2-digit", month: "short" })}
                                </span>
                              </div>
                            );
                          })
                        ) : (
                          <div className="col-span-3 text-center py-6 text-stone-400 text-xs italic">
                            Nessun nuovo compito o culto pianificato nell'agenda.
                          </div>
                        )}
                      </div>
                    </div>

                  </div>
                ) : (
                  /* SCHERMATA QUANDO TUTTE LE COSE SONO UGUALI (NESSUNA MODIFICA) */
                  <div className="flex flex-col items-center justify-center py-16 px-6 gap-5 bg-stone-50/55 border border-[#e2e2d8] rounded-[20px] text-center">
                    <div className="w-16 h-16 rounded-full bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-700 shadow-sm">
                      <Check className="w-8 h-8 stroke-[3]" />
                    </div>
                    <div className="flex flex-col gap-2 max-w-lg">
                      <h3 className="text-xl font-serif italic text-[#2d3a27] font-semibold">
                        Niente è stato modificato, niente è stato aggiornato
                      </h3>
                      <p className="text-xs text-stone-500 leading-relaxed">
                        Tutto è identico all'ultima volta che lo hai controllato. Non ci sono nuove note sul diario, nuove piante aggiunte o nuovi impegni inseriti in agenda dall'ultimo accesso. 🌱
                      </p>
                    </div>
                  </div>
                )}

                {/* BOTTONE CHIUSURA / ATTIVAZIONE VISUALIZZAZIONE COMPLETA DELL'ERBARIO */}
                <div className="border-t border-[#e2e2d8] pt-5 flex items-center justify-center mt-2.5">
                  <button
                    onClick={handleMarkUpdatesAsSeen}
                    className="w-full sm:w-auto px-10 py-3.5 bg-[#2d3a27] hover:bg-[#1e271a] text-white font-bold rounded-full shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer group text-sm animate-pulse"
                  >
                    {hasNewUpdates ? "Guarda gli aggiornamenti" : "Visualizza il diario botanico"}
                    <ChevronRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                  </button>
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* HEADER / NAVIGATION BAR */}
      <header className="bento-card p-5 bg-white border border-[#e2e2d8] rounded-[28px] flex flex-col md:flex-row items-start md:items-center justify-between gap-5 shadow-[0_2px_8px_rgba(45,58,39,0.02)]">
        {/* Left Brand Block */}
        <div className="flex items-center gap-4 w-full md:w-auto text-left">
          {/* Brand Icon */}
          <div className="p-3 bg-[#2d3a27] rounded-[22px] text-white flex items-center justify-center shrink-0 w-[54px] h-[54px]">
            <Sprout className="w-7 h-7" />
          </div>
          {/* Brand Text Content */}
          <div className="flex flex-col min-w-0">
            <h1 className="text-xl sm:text-2xl font-serif text-[#2d3a27] font-semibold tracking-tight leading-none text-left">
              <span className="italic">Flora</span> <span className="font-normal not-italic text-stone-500 font-serif">— Botanical Archive</span>
            </h1>
            
            {/* Metadata columns with absolute alignment conformity to the user's mockup */}
            <div className="flex items-center gap-x-6 mt-2 text-[10px] font-mono tracking-wider text-stone-500 uppercase leading-snug">
              <div>
                <div className="text-stone-400 font-bold text-[9px] tracking-wider leading-none">ORTO BOTANICO DI</div>
                <div className="text-stone-500 font-bold text-[11px] tracking-wide mt-1 leading-none">
                  {state.settings.userName.toUpperCase()}
                </div>
              </div>
              
              <div className="flex items-start gap-1.5">
                <div className={`w-2 h-2 rounded-full mt-1 shrink-0 ${isReadOnlyMode ? "bg-stone-300" : "bg-[#7e8c69] animate-[pulse_3s_infinite]"}`}></div>
                <div>
                  <div className="text-stone-400 font-bold text-[9px] tracking-wider leading-none">{isReadOnlyMode ? "SHARED" : "AUTOSAVE"}</div>
                  <div className="text-stone-500 font-bold text-[11px] tracking-wide mt-1 leading-none">{isReadOnlyMode ? "SHARED" : "ACTIVATED"}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sync Indicator & Quick Actions */}
        <div className="flex flex-wrap items-center gap-2.5 w-full md:w-auto">
          {/* Sistema Sincronizzato Live pill */}
          {isReadOnlyMode ? (
            <div 
              onClick={handleSyncPillClick}
              className="bg-[#5a5a40]/90 text-white px-4 py-2.5 rounded-full text-[11px] font-semibold flex items-center gap-2 shadow-sm shrink-0 cursor-pointer select-none hover:bg-[#5a5a40] active:scale-95 transition-all"
              title="Clicca 5 volte per sbloccare la modalità Editor"
            >
              <div className="w-1.5 h-1.5 bg-[#38bdf8] rounded-full animate-pulse shrink-0"></div>
              <span>Sincronizzato (Lettura) 👁️</span>
            </div>
          ) : (
            <div 
              onClick={handleSyncPillClick}
              className="bg-[#7e8c69] hover:bg-[#90a48a] text-white px-4 py-2.5 rounded-full text-[11px] font-semibold flex items-center gap-2 shadow-sm shrink-0 cursor-pointer select-none ring-2 ring-emerald-500/20 active:scale-95 transition-all"
              title="Clicca 5 volte per tornare in modalità Visualizzatore"
            >
              <div className="w-1.5 h-1.5 bg-[#4ade80] rounded-full animate-pulse shrink-0"></div>
              <span>Sincronizzato (Editor) ✨⚙️</span>
            </div>
          )}



          <button
            onClick={handleCopyShareLink}
            className="flex items-center gap-1.5 p-2 px-4 bg-white border border-[#e2e2d8] rounded-full text-xs font-semibold text-stone-700 hover:bg-[#fafaf7] transition-all shadow-sm cursor-pointer shrink-0"
            title="Copia link crittografato"
          >
            <Share2 className="w-3.5 h-3.5 text-stone-500 shrink-0" />
            Condividi
          </button>

          {!isReadOnlyMode && (
            <>
              <button
                onClick={handleDownloadZIP}
                className="flex items-center gap-1.5 p-2 px-4 bg-[#eefcf3] border border-[#d3f4e3] rounded-full text-xs font-semibold text-[#137333] hover:bg-emerald-100/60 transition-all cursor-pointer shrink-0"
                title="Scarica tutti i dati della tua serra come archivio compresso ZIP"
              >
                <Download className="w-3.5 h-3.5 text-[#137333] shrink-0" />
                Scarica ZIP
              </button>
              <label
                htmlFor="zip-state-upload"
                className="flex items-center gap-1.5 p-2 px-4 bg-white border border-[#e2e2d8] rounded-full text-xs font-semibold text-stone-700 hover:bg-stone-50 transition-all cursor-pointer shrink-0"
                title="Seleziona un archivio ZIP precedentemente salvato per ripristinare i dati della tua serra"
              >
                <Upload className="w-3.5 h-3.5 text-stone-500 shrink-0" />
                Carica ZIP
              </label>
              <input
                id="zip-state-upload"
                type="file"
                accept=".zip"
                onChange={handleUploadZIP}
                className="hidden"
                onClick={(e) => {
                  (e.target as HTMLInputElement).value = "";
                }}
              />
            </>
          )}

          {!isReadOnlyMode && (
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="w-10 h-10 flex items-center justify-center bg-white border border-[#e2e2d8] hover:bg-sage-50 rounded-full text-stone-600 transition-all cursor-pointer shadow-sm shrink-0"
              title="Impostazioni orto"
            >
              <Info className="w-4.5 h-4.5 shrink-0" />
            </button>
          )}
        </div>
      </header>

      {/* STRUMENTO DI SINCRONIZZAZIONE IMMEDIATA CLOUD (RICHIESTA UTENTE) */}
      <div className="bento-card p-4 mt-4 bg-gradient-to-r from-[#fbfbf8] to-[#f4f7f2] border border-[#d6ded0] rounded-2xl flex flex-col md:flex-row items-center justify-between gap-4 shadow-sm relative z-20">
        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="p-2.5 bg-sage-50 border border-sage-200 rounded-xl text-stone-650 shrink-0">
            <RefreshCcw className={`w-4 h-4 ${isSyncing ? "animate-spin text-[#7e8c69]" : "text-stone-500"}`} />
          </div>
          <div className="text-left">
            <div className="flex items-center gap-2">
              <span className="font-sans font-semibold text-stone-800 text-xs uppercase tracking-wider">Centro Sincronizzazione Cloud</span>
              <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${isReadOnlyMode ? "bg-[#e2e8f0] text-slate-600" : "bg-[#d1fae5] text-emerald-700 animate-pulse"}`}>
                {isReadOnlyMode ? "Live Sola Lettura" : "Auto-Salvataggio Attivo"}
              </span>
            </div>
            <p className="text-[11px] text-stone-500 mt-0.5 leading-snug">
              {isSyncing ? (
                <span className="text-stone-600 font-medium animate-pulse">🛠️ {syncStatusMessage || "Operazione in corso... Attendere."}</span>
              ) : (
                <span>Ultimo backup online: <strong className="font-mono text-stone-700">{state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : "N/D (Caricare dati)"}</strong>. Le foto vengono compresse a 15KB per viaggiare velocissime!</span>
              )}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto md:justify-end">
          {!isReadOnlyMode && (
            <button
              onClick={handleForceDownload}
              disabled={isSyncing}
              className="flex items-center justify-center gap-1.5 px-4 py-2 bg-white border border-[#ccd4ca] hover:bg-stone-50 text-stone-700 rounded-xl text-xs font-semibold cursor-pointer transition-all active:scale-95 shadow-sm disabled:opacity-50"
              title="Forza lo scaricamento e sincronizzazione in discesa dell'orto dal Cloud"
            >
              <RefreshCcw className="w-3.5 h-3.5 text-stone-500 shrink-0" />
              Scarica dal Cloud (Forza Aggiornamento)
            </button>
          )}

          {!isReadOnlyMode && (
            <button
              onClick={handleForceUpload}
              disabled={isSyncing}
              className="flex items-center justify-center gap-1.5 px-4 py-2 bg-[#7e8c69] hover:bg-[#6b7b58] text-white rounded-xl text-xs font-bold cursor-pointer transition-all active:scale-95 shadow-sm disabled:opacity-50 ring-2 ring-[#7e8c69]/20"
              title="Carica istantaneamente il giardino sul cloud ottimizzando tutte le immagini"
            >
              <Upload className="w-3.5 h-3.5 shrink-0" />
              Forza Salvataggio (Upload immediato)
            </button>
          )}
        </div>
      </div>

      {/* BANNER INSTALLAZIONE APP (PWA) */}
      {(!isReadOnlyMode && !pwaBannerDismissed && !isPwaInstalled && (pwaPrompt || (typeof window !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream && !(window.matchMedia('(display-mode: standalone)').matches || (window.navigator as any).standalone)))) && (
        <div id="pwa-install-banner" className="bento-card bg-gradient-to-r from-sage-800 to-[#1e271a] text-white p-5 flex flex-col md:flex-row items-center justify-between gap-4 relative overflow-hidden shadow-lg border border-sage-700/30">
          <div className="absolute top-0 right-0 p-8 opacity-5 pointer-events-none transform translate-x-4 -translate-y-4">
            <Sprout className="w-40 h-40 font-bold text-white" />
          </div>
          <div className="flex items-start gap-3.5 relative z-10 w-full md:w-auto">
            <div className="p-3 bg-white/10 backdrop-blur-md rounded-2xl flex items-center justify-center shrink-0">
              <Sparkles className="w-5 h-5 text-emerald-300 animate-pulse" />
            </div>
            <div>
              <h3 className="font-serif italic text-base font-semibold text-emerald-100 flex items-center gap-1.5">
                Installa l'App di Flora sul tuo Schermo! 🌿📱
              </h3>
              <p className="text-xs text-stone-300 leading-relaxed max-w-xl mt-1">
                {pwaPrompt ? (
                  "Aggiungi Flora alla schermata home del tuo telefono per aprirla istantaneamente, a schermo intero e ricevere tutti gli aggiornamenti live in tempo reale!"
                ) : (
                  "Tocca il tasto Condividi di Safari (quadrato con freccia verso l'alto) in basso e seleziona 'Aggiungi alla schermata Home' per installare Flora su iPhone!"
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 relative z-10 self-end md:self-center shrink-0">
            {pwaPrompt && (
              <button
                onClick={() => {
                  if (pwaPrompt) {
                    pwaPrompt.prompt();
                    pwaPrompt.userChoice.then((choiceResult: any) => {
                      if (choiceResult.outcome === "accepted") {
                        console.log("L'utente ha accettato l'installazione di Flora.");
                        setIsPwaInstalled(true);
                      }
                      setPwaPrompt(null);
                    });
                  }
                }}
                id="pwa-btn-install"
                className="px-4 py-2 bg-[#b2cfa5] hover:bg-[#a1bf94] text-[#1e271a] rounded-full text-xs font-bold transition-all shadow-md cursor-pointer flex items-center gap-1.5"
              >
                Aggiungi Schermo
              </button>
            )}
            <button
              onClick={() => {
                localStorage.setItem("flora_pwa_dismissed", "true");
                setPwaBannerDismissed(true);
              }}
              id="pwa-btn-dismiss"
              className="p-2 border border-white/20 hover:bg-white/10 rounded-full text-stone-300 hover:text-white transition-all cursor-pointer"
              title="Nascondi avviso"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* DASHBOARD BAR - METRICHE FLUIDE */}
      <section className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
        <div className="bento-card p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-[#faf6f0] text-[#7e8c69] flex items-center justify-center">
            <BookOpen className="w-4.5 h-4.5 text-[#7e8c69]" />
          </div>
          <div>
            <p className="text-[9px] font-mono uppercase tracking-wider text-[#8e9299]">Specie Attive</p>
            <div className="text-base font-serif italic font-bold text-sage-800">{activePlants.length} Piante</div>
          </div>
        </div>

        <div className="bento-card p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-[#e9e9df] text-[#2d3a27] flex items-center justify-center">
            <Activity className="w-4.5 h-4.5 text-[#2d3a27]" />
          </div>
          <div>
            <p className="text-[9px] font-mono uppercase tracking-wider text-[#8e9299]">Salute Orto</p>
            <div className="text-base font-serif italic font-bold text-[#2d3a27]">
              {activePlants.length > 0
                ? Math.round(activePlants.reduce((acc, p) => acc + p.health, 0) / activePlants.length)
                : 100}% media
            </div>
          </div>
        </div>

        <div className="bento-card p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-[#faf6f0] text-amber-900 flex items-center justify-center">
            <CalendarClock className="w-4.5 h-4.5 text-amber-700" />
          </div>
          <div>
            <p className="text-[9px] font-mono uppercase tracking-wider text-[#8e9299]">Da Fare</p>
            <div className="text-base font-serif italic font-bold text-amber-800">
              {state.activities.filter(a => a.status === "todo").length} Attività
            </div>
          </div>
        </div>

        <div 
          onClick={() => setIsHistoryOpen(true)}
          className="bento-card p-4 flex items-center gap-3 cursor-pointer bg-gradient-to-tr from-[#fbfafa] to-[#f4f2ef] hover:to-[#ebe8e4] hover:shadow-xs border border-stone-200 hover:border-stone-400 group transition-all"
        >
          <div className="p-2.5 rounded-xl bg-[#e9e9df] text-[#7e8c69] flex items-center justify-center transition-all group-hover:bg-emerald-50 group-hover:text-emerald-800">
            <Check className="w-4.5 h-4.5 text-sage-800 group-hover:text-emerald-750 transition-colors" />
          </div>
          <div>
            <p className="text-[9px] font-mono uppercase tracking-wider text-stone-500">Storico Cure</p>
            <div className="text-base font-serif italic font-bold text-sage-800 group-hover:text-emerald-800 transition-colors">
              {state.activities.filter(a => a.status === "completed").length} concluse
            </div>
          </div>
        </div>

        {/* METRICA 5: MEMORIALE PIANTE PASSTATE */}
        <div 
          onClick={() => setIsMemorialOpen(true)}
          className="bento-card p-4 flex items-center gap-3 cursor-pointer bg-gradient-to-tr from-[#fbfafa] to-[#f4f2ef] hover:to-[#ebe8e4] hover:shadow-xs border border-stone-200 hover:border-stone-400 group transition-all"
        >
          <div className="p-2.5 rounded-xl bg-stone-100 text-stone-600 group-hover:bg-red-50 group-hover:text-red-600 flex items-center justify-center transition-all">
            <Skull className="w-4.5 h-4.5" />
          </div>
          <div>
            <p className="text-[9px] font-mono uppercase tracking-wider text-stone-500">Memoriale</p>
            <div className="text-base font-serif italic font-bold text-stone-800 group-hover:text-red-700 transition-colors flex items-center gap-1">
              {deadPlants.length} {deadPlants.length === 1 ? "Ricordo" : "Ricordi"}
            </div>
          </div>
        </div>

        {/* METRICA 6: AGENDA ED ATTIVITÀ INTELLIGENTI */}
        <div 
          onClick={() => setIsAgendaOpen(true)}
          className="bento-card p-4 flex items-center gap-3 cursor-pointer bg-gradient-to-tr from-[#fafbf9] to-[#edf0ea] hover:to-[#dfebd4] hover:shadow-xs border border-emerald-250 hover:border-emerald-400 group transition-all"
        >
          <div className="p-2.5 rounded-xl bg-emerald-50 text-emerald-700 group-hover:bg-emerald-100 group-hover:text-emerald-800 flex items-center justify-center transition-all">
            <Calendar className="w-4.5 h-4.5" />
          </div>
          <div>
            <p className="text-[9px] font-mono uppercase tracking-wider text-emerald-600">Agenda & Culti</p>
            <div className="text-base font-serif italic font-bold text-emerald-800 transition-colors flex items-center gap-1">
              {(state.smartTrackers || []).filter(t => !t.isCompleted).length} Attivi
            </div>
          </div>
        </div>
      </section>

      {/* CORE BOTANICAL WORKSPACE SCREEN */}
      <main className="grid grid-cols-1 lg:grid-cols-12 gap-6 w-full items-start">
        
        {/* COLONNA SINISTRA ERBARIO: spans 3 */}
        <div className="lg:col-span-3 bento-card p-5 flex flex-col gap-4 bg-white h-auto lg:h-[720px] overflow-hidden">
          
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-mono uppercase tracking-widest text-[#2d3a27] font-bold">Il Tuo Erbario</h2>
              {!isReadOnlyMode && (
                <button
                  onClick={() => setIsAddPlantOpen(true)}
                  className="flex items-center gap-1 text-[11px] font-mono uppercase font-semibold text-[#2d3a27] hover:text-[#7e8c69] transition-colors h-6 px-2.5 bg-[#f5f5f0] border border-[#e2e2d8] rounded-full cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" /> Nuova
                </button>
              )}
            </div>

            {/* Ricerca */}
            <div className="relative">
              <Search className="absolute left-3 top-2.5 w-3.5 h-3.5 text-[#5a5a40]" />
              <input
                type="text"
                placeholder="Cerca nome, tag..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-4 py-2 text-xs bg-[#f5f5f0] text-sage-950 placeholder-sage-400 rounded-xl border border-transparent focus:border-sage-300 focus:bg-white focus:outline-none transition-all"
              />
            </div>

            {/* Filtri */}
            <div className="grid grid-cols-2 gap-2 text-[10px]">
              <div className="flex flex-col gap-1">
                <span className="text-sage-400 font-mono text-[9px] uppercase tracking-wider">Stato</span>
                <select
                  value={selectedStatusFilter}
                  onChange={e => setSelectedStatusFilter(e.target.value)}
                  className="bg-[#f5f5f0] border-none text-sage-800 rounded-xl p-1.5 text-[10px] focus:outline-none cursor-pointer"
                >
                  <option value="all">Tutti</option>
                  <option value="germoglio">Germoglio</option>
                  <option value="crescita">Crescita</option>
                  <option value="stabile">Stabile</option>
                  <option value="fioritura">Fioritura</option>
                  <option value="stress">Stress</option>
                  <option value="recupero">In Recupero</option>
                  <option value="propagazione">Propagazione</option>
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-sage-400 font-mono text-[9px] uppercase tracking-wider">Tag</span>
                <select
                  value={selectedTagFilter}
                  onChange={e => setSelectedTagFilter(e.target.value)}
                  className="bg-[#f5f5f0] border-none text-sage-800 rounded-xl p-1.5 text-[10px] focus:outline-none cursor-pointer"
                >
                  <option value="all">Tutti</option>
                  {allTags.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <hr className="border-[#e2e2d8]" />

          {/* LISTA DELLE PIANTE */}
          <div className="flex-1 overflow-y-auto max-h-[350px] lg:max-h-full space-y-3 pr-1">
            {filteredPlants.length === 0 ? (
              <div className="text-center py-12 text-[#8e9299]">
                <Sprout className="w-8 h-8 mx-auto stroke-[1.5] opacity-50 mb-2" />
                <p className="text-xs font-serif italic">Nessun elemento.</p>
              </div>
            ) : (
              filteredPlants.map(p => {
                const isSelected = p.id === selectedPlantId;
                const ageDays = calculateAge(p.startDate);

                return (
                  <motion.div
                    key={p.id}
                    onMouseDown={(e) => handlePlantLongPressStart(e, p)}
                    onTouchStart={(e) => handlePlantLongPressStart(e, p)}
                    onMouseUp={handleLongPressEnd}
                    onTouchEnd={handleLongPressEnd}
                    onMouseLeave={handleLongPressEnd}
                    onClick={(e) => handleElementClick(e, () => {
                      setSelectedPlantId(p.id);
                      setTimeout(() => {
                        detailsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }, 50);
                    })}
                    whileHover={{ scale: 1.01 }}
                    title="Tieni premuto per Modificare o Eliminare questa pianta"
                    className={`p-3 rounded-2xl border cursor-pointer transition-all flex gap-3 relative overflow-hidden ${
                      isSelected
                        ? "bg-[#fafafa] border-[#7e8c69] shadow-sm"
                        : "bg-white border-[#e2e2d8] hover:bg-slate-50/50"
                    }`}
                  >
                    <div className="absolute top-0 left-0 w-1 h-full rounded-r-md" style={{
                      backgroundColor: p.health > 80 ? "#7e8c69" : p.health > 50 ? "#d68a56" : "#ac7d44"
                    }} />

                    <div className="w-12 h-12 rounded-xl overflow-hidden bg-sage-50 flex-shrink-0 border border-[#e2e2d8]">
                      <img src={p.imageUrl} alt={p.name} className="w-full h-full object-cover" />
                    </div>

                    <div className="flex-1 min-w-0 flex flex-col justify-between">
                      <div className="flex justify-between items-start gap-1">
                        <h4 className="text-xs font-bold text-[#2d3a27] truncate tracking-tight">{p.name}</h4>
                        <div className="flex flex-col items-end flex-shrink-0 gap-0.5">
                          <span className="text-[9px] font-mono text-sage-400">{ageDays} gg</span>
                          {(() => {
                            const plantActivities = (state.activities || []).filter(a => a.plantId === p.id && a.status === "todo");
                            const pendingCount = plantActivities.length;
                            if (pendingCount > 0) {
                              const todayStr = new Date().toISOString().split("T")[0];
                              const hasUrgent = plantActivities.some(a => a.dueDate <= todayStr);
                              return (
                                <span 
                                  className={`text-[8px] font-mono font-extrabold px-1 py-0.5 rounded flex items-center gap-0.5 transition-all ${
                                    hasUrgent 
                                      ? "bg-red-50 text-red-600 border border-red-200 animate-pulse" 
                                      : "bg-sage-100 text-[#4c5938]"
                                  }`}
                                  title={hasUrgent ? "C'è un'attività in scadenza oggi o scaduta!" : "Attività in agenda"}
                                >
                                  Agenda: {pendingCount}
                                </span>
                              );
                            }
                            return null;
                          })()}
                        </div>
                      </div>
                      
                      <p className="text-[11px] text-[#7e8c69] italic font-serif">
                        « {p.nickname} »
                      </p>

                      <div className="flex items-center justify-between mt-1 text-[9px] font-mono">
                        <span className={`px-2 py-0.5 rounded-full text-[8px] font-semibold uppercase tracking-wider ${
                          p.status === PlantStatus.FIORITURA ? "bg-[#7e8c69] text-white" :
                          p.status === PlantStatus.STRESS ? "bg-orange-100 text-[#d68a56]" :
                          "bg-sage-50 text-[#5a5a40]"
                        }`}>
                          {p.status}
                        </span>

                        <span className="text-sage-500 font-semibold">{p.health}% salute</span>
                      </div>
                    </div>
                  </motion.div>
                );
              })
            )}
          </div>
        </div>

        {/* COLONNA CENTRALE DETAIL: spans 6 */}
        <div className="lg:col-span-6 flex flex-col gap-6" ref={detailsSectionRef}>
          {selectedPlant ? (
            isSavedNotesViewOpen ? (
              <SavedNotesView
                plant={selectedPlant}
                allPlants={state.plants}
                onBack={() => setIsSavedNotesViewOpen(false)}
                onUpdateNotes={(plantId, updatedNotes) => {
                  setState(prev => ({
                    ...prev,
                    plants: prev.plants.map(p => {
                      if (p.id === plantId) {
                        return {
                          ...p,
                          savedNotes: updatedNotes
                        };
                      }
                      return p;
                    })
                  }));
                }}
                isReadOnlyMode={isReadOnlyMode}
                showToast={showToast}
              />
            ) : (
              <>
                {/* STILE EDITORIALE BENTO DETAIL */}
                <div className="bento-card overflow-hidden bg-white">
                <div className="flex flex-col md:flex-row">
                  {/* Image Grid Frame resembling garden bento item */}
                  <div className="md:w-5/12 h-64 md:h-auto overflow-hidden relative min-h-[280px] bg-sage-50 border-r border-[#e2e2d8] cursor-zoom-in" onClick={() => setFullscreenImageUrl(selectedPlant.imageUrl)} title="Clicca per visualizzare a schermo intero">
                    <img src={selectedPlant.imageUrl} alt={selectedPlant.name} className="w-full h-full object-cover transition-transform duration-700 hover:scale-105" />
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/50 via-transparent to-transparent md:hidden p-4">
                      <span className="text-[9px] uppercase font-mono tracking-widest bg-[#2d3a27] p-1 px-2.5 rounded-full text-white">
                        {selectedPlant.status}
                      </span>
                    </div>
                  </div>

                  {/* Body Details with high luxury spacing */}
                  <div className="p-6 md:w-7/12 flex flex-col justify-between gap-4">
                    <div>
                      <div className="flex justify-between items-start">
                        <span className="plant-badge">{selectedPlant.species}</span>
                        
                        {!isReadOnlyMode && (
                          <div className="flex gap-2">
                            <button
                              onClick={handleOpenEdit}
                              className="p-1 px-2.5 bg-[#f5f5f0] border border-[#e2e2d8] hover:bg-white rounded-lg text-sage-800 text-[10px] font-semibold transition-all flex items-center gap-1 cursor-pointer"
                            >
                              <Edit className="w-3" /> Modifica
                            </button>

                            <button
                              onClick={() => handleDuplicatePlant(selectedPlant.id)}
                              className="p-1 px-2.5 bg-[#f5f5f0] border border-[#e2e2d8] hover:bg-white rounded-lg text-sage-800 text-[10px] font-semibold transition-all flex items-center gap-1 cursor-pointer"
                              title="Copia questa pianta duplicandone tutte le sue note, l'agenda e i doveri"
                            >
                              <Copy className="w-3" /> Copia
                            </button>

                            {selectedPlant.isDead ? (
                              <button
                                onClick={() => handleRevivePlant(selectedPlant.id)}
                                className="p-1 px-2.5 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded-lg text-emerald-700 text-[10px] font-semibold transition-all flex items-center gap-1 cursor-pointer"
                              >
                                <Sprout className="w-3" /> Ripristina Pianta
                              </button>
                            ) : (
                              <button
                                onClick={() => {
                                  setPlantIdToDeclareDead(selectedPlant.id);
                                  setDeathNotesInput("");
                                  setIsDeathModalOpen(true);
                                }}
                                className="p-1 px-2.5 bg-stone-100 border border-stone-200 hover:bg-stone-200 rounded-lg text-stone-700 text-[10px] font-semibold transition-all flex items-center gap-1 cursor-pointer"
                                title="Segnala come passata"
                              >
                                <Skull className="w-3" /> Decesso Pianta
                              </button>
                            )}

                            <button
                              onClick={() => handleDeletePlant(selectedPlant.id)}
                              className="p-1 px-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-[10px] font-semibold transition-all flex items-center gap-1 cursor-pointer border border-red-700 shadow-sm active:scale-95"
                              title="Rimuovi pianta permanentemente"
                            >
                              <Trash2 className="w-3" /> Elimina Pianta
                            </button>

                            <button
                              onClick={() => setIsSavedNotesViewOpen(true)}
                              className="p-1 px-2.5 bg-[#4c5938] hover:bg-[#2d3a27] text-white rounded-lg text-[10px] font-semibold transition-all flex items-center gap-1 cursor-pointer border border-[#4c5938] shadow-sm active:scale-95"
                              title="Note Salvate della pianta (istruzioni di cura, bisogni e consigli)"
                            >
                              <BookOpen className="w-3" /> Note Salvate
                            </button>
                          </div>
                        )}
                      </div>

                      <h2 className="text-3xl font-serif italic text-[#2d3a27] mt-2 mb-1">
                        {selectedPlant.name}
                      </h2>

                      {selectedPlant.isDead && (
                        <div className="my-3 p-3 bg-stone-100 border border-stone-200 rounded-2xl flex items-start gap-2.5 text-stone-700">
                          <Skull className="w-4 h-4 text-stone-500 mt-0.5 shrink-0" />
                          <div className="text-[11px] leading-relaxed font-sans w-full">
                            <p className="font-bold font-mono text-[9px] uppercase text-stone-500">Memoriale Botanico • Passata il {selectedPlant.deathDate ? new Date(selectedPlant.deathDate).toLocaleDateString("it-IT") : ""}</p>
                            <p className="italic mt-0.5 text-stone-600 whitespace-pre-wrap">"{selectedPlant.deathNotes || "La pianta è conservata con affetto nel nostro ricordo."}"</p>
                          </div>
                        </div>
                      )}

                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] font-mono tracking-wider uppercase text-sage-400">Soprannome:</span>
                        <span className="text-lg font-handwritten text-[#7e8c69] font-bold">
                          {selectedPlant.nickname}
                        </span>
                      </div>

                      <p className="text-xs text-sage-650 leading-relaxed mt-4 font-normal whitespace-pre-wrap">
                        {selectedPlant.description}
                      </p>

                      {/* Display tags */}
                      {selectedPlant.tags && selectedPlant.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-4">
                          {selectedPlant.tags.map(t => (
                            <span key={t} className="text-[9px] font-mono uppercase tracking-widest bg-[#f5f5f0] text-sage-700 rounded-md p-1 px-2">
                              #{t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Stat indicators in Serif styling inspired by Bento HTML */}
                    <div className="pt-4 border-t border-[#e2e2d8] grid grid-cols-3 gap-3">
                      <div>
                        <span className="text-[9px] font-mono uppercase tracking-widest text-[#8e9299]">Età calcolata</span>
                        <div className="font-serif text-[#2d3a27] font-bold text-lg mt-0.5">
                          {calculateAge(selectedPlant.startDate)} <span className="text-[10px] font-sans font-bold uppercase text-[#8fa28b]">Giorni</span>
                        </div>
                      </div>

                      <div>
                        <span className="text-[9px] font-mono uppercase tracking-widest text-[#8e9299]">Salute</span>
                        <div className="flex items-center gap-1 mt-0.5">
                          <Heart className="w-4 h-4 text-red-500 fill-current" />
                          <span className="font-serif text-[#2d3a27] font-bold text-lg">{selectedPlant.health}%</span>
                        </div>
                      </div>

                      <div>
                        <span className="text-[9px] font-mono uppercase tracking-widest text-[#8e9299]">Origine</span>
                        <span className="font-serif italic font-bold text-xs text-sage-800 tracking-wide block mt-1 uppercase">{selectedPlant.origin}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* SAVED NOTES PIECE: replacing AI curator */}
              <div 
                onClick={() => setIsSavedNotesViewOpen(true)}
                className="bento-card p-6 bg-white hover:border-[#7e8c69] transition-all cursor-pointer space-y-4 group"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-[#7e8c69]" />
                    <h3 className="font-serif italic text-[#2d3a27] text-sm font-bold">Note Salvate</h3>
                  </div>
                  <span className="text-[10px] font-mono uppercase bg-[#f5f5f0] text-sage-700 px-2.5 py-1 rounded-full group-hover:bg-[#7e8c69] group-hover:text-white transition-colors">
                    Apri Archivio
                  </span>
                </div>

                {selectedPlant.savedNotes && selectedPlant.savedNotes.length > 0 ? (
                  <div className="flex items-center gap-4 bg-[#fbfbf9] p-4 rounded-2xl border border-[#e2e2d8] group-hover:border-sage-300 transition-all">
                    <div className="w-12 h-12 bg-[#7e8c69]/10 rounded-xl flex items-center justify-center text-[#7e8c69] shrink-0 font-serif text-lg font-black">
                      {selectedPlant.savedNotes.length}
                    </div>
                    <div>
                      <p className="text-xs font-serif font-bold text-[#2d3a27]">
                        {selectedPlant.savedNotes.length === 1 ? "1 Nota Salvata" : `${selectedPlant.savedNotes.length} Note Salvate`}
                      </p>
                      <p className="text-[11px] text-sage-500">
                        Clicca per leggerle a schermo intero, modificarle o aggiungerne di nuove.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="bg-[#fbfbf9] p-4 rounded-2xl border border-dashed border-sage-300 text-center space-y-2 group-hover:border-sage-400 transition-all">
                    <p className="text-xs text-sage-500 font-serif italic">
                      Nessuna nota salvata per questa pianta.
                    </p>
                    <p className="text-[10px] text-sage-400">
                      Clicca qui per aggiungere promemoria, istruzioni, annaffiature particolari e foto.
                    </p>
                  </div>
                )}
              </div>

              {/* TIME-LINE MEMORIA */}
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-[#e2e2d8] pb-2">
                  <h3 className="text-xs font-mono uppercase tracking-widest text-[#8e9299] font-bold flex items-center gap-2">
                    <FileText className="w-4 h-4 text-sage-600" />
                    Timeline Memoria Botanica
                  </h3>
                  <div className="flex items-center gap-1.5">
                    {!isReadOnlyMode && (
                      <button
                        onClick={() => setIsNewDiaryOpen(true)}
                        className="flex items-center gap-1 text-[11px] font-mono uppercase font-semibold text-sage-800 hover:text-[#2d3a27] transition-all border border-[#e2e2d8] rounded-full px-3.5 py-1 bg-white hover:bg-[#f5f5f0] cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5 text-sage-500" /> Registra Nota
                      </button>
                    )}
                    {selectedPlant.diary && selectedPlant.diary.length > 0 && (
                      <button
                        onClick={() => {
                          latestNoteRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                          showToast("Scorrendo all'ultima nota registrata...");
                        }}
                        className="p-1.5 bg-white border border-[#e2e2d8] hover:bg-sage-50 rounded-full text-sage-600 transition-all cursor-pointer shadow-sm flex items-center justify-center"
                        title="Vai all'ultima nota registrata"
                      >
                        <ArrowDown className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="relative pl-6 border-l border-dashed border-[#d8d8ce] space-y-5 pt-2">
                  {selectedPlant.diary && selectedPlant.diary.map((entry, index) => {
                    const iconColor =
                      entry.category === "creazione" ? "#2d3a27" :
                      entry.category === "annaffiatura" ? "#3b82f6" :
                      entry.category === "concimazione" ? "#7e8c69" :
                      entry.category === "rinvaso" ? "#d68a56" :
                      "#5a5a40";

                    return (
                      <motion.div
                        key={entry.id}
                        ref={index === 0 ? latestNoteRef : undefined}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.05 }}
                        className="relative bento-card p-4 bg-white active:scale-[0.99] select-none transition-all cursor-pointer hover:border-red-100"
                        onMouseDown={(e) => handleLongPressStart(e, entry.id, "diary", entry.eventTitle, selectedPlant.id)}
                        onTouchStart={(e) => handleLongPressStart(e, entry.id, "diary", entry.eventTitle, selectedPlant.id)}
                        onMouseUp={handleLongPressEnd}
                        onTouchEnd={handleLongPressEnd}
                        onMouseLeave={handleLongPressEnd}
                        onClick={(e) => handleElementClick(e, () => {
                          showToast("Tieni premuto per eliminare questa nota dal diario biologico. 📒");
                        })}
                        title={isReadOnlyMode ? "Cronologia in sola lettura" : "Tieni premuto per eliminare questa nota"}
                      >
                        {/* Dot exactly like the design timeline */}
                        <div
                          className="w-2.5 h-2.5 rounded-full absolute -left-[31px] top-6 border-2 border-white ring-1 ring-[#d8d8ce]"
                          style={{ backgroundColor: iconColor }}
                        />

                        <div className="flex items-center justify-between text-[11px] font-mono text-sage-400">
                          <span className="font-medium">Registrato il: {new Date(entry.date).toLocaleDateString("it-IT", {
                            day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
                          })}</span>

                          <div className="flex items-center gap-1.5">
                            {!isReadOnlyMode && (
                              <>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    moveDiaryEntry(entry.id, selectedPlant.id, "up");
                                  }}
                                  className="p-1 hover:bg-sage-100/60 rounded-lg text-sage-500 hover:text-emerald-600 transition-all cursor-pointer flex items-center justify-center bg-stone-50/50"
                                  title="Sposta sopra"
                                >
                                  <ArrowUp className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    moveDiaryEntry(entry.id, selectedPlant.id, "down");
                                  }}
                                  className="p-1 hover:bg-sage-100/60 rounded-lg text-sage-500 hover:text-emerald-600 transition-all cursor-pointer flex items-center justify-center bg-stone-50/50"
                                  title="Sposta sotto"
                                >
                                  <ArrowDown className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                startEditDiary(entry.id, selectedPlant.id);
                              }}
                              className="p-1 hover:bg-sage-100/60 rounded-lg text-sage-500 hover:text-indigo-600 transition-all cursor-pointer flex items-center justify-center bg-stone-50/50"
                              title="Modifica nota"
                            >
                              <Edit className="w-3.5 h-3.5" />
                            </button>
                            <span className="capitalize text-[8px] tracking-wider uppercase bg-[#f5f5f0] border border-[#e2e2d8] font-bold p-0.5 px-2 rounded-md font-mono text-sage-600">
                              {entry.category || "osservazione"}
                            </span>
                          </div>
                        </div>

                        <h4 className="font-serif italic font-bold text-[#2d3a27] mt-1.5 text-[14px]">{entry.eventTitle}</h4>
                        <p className="text-xs text-sage-600 mt-1 leading-relaxed font-sans whitespace-pre-wrap">{entry.notes}</p>

                        {/* INTERACTIVE DAYS OF LIFE BADGE */}
                        {(() => {
                          const ageAtMoment = calculateAgeAtDate(selectedPlant.startDate, entry.date);
                          const currentAgeOfPlant = calculateAge(selectedPlant.startDate);
                          const daysPassed = Math.max(0, currentAgeOfPlant - ageAtMoment);
                          const isToggled = !!toggledDiaryAges[entry.id];

                          return (
                            <div 
                              onClick={(e) => {
                                e.stopPropagation();
                                setToggledDiaryAges(prev => ({
                                  ...prev,
                                  [entry.id]: !prev[entry.id]
                                }));
                              }}
                              className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-[10px] font-mono font-bold transition-all cursor-pointer border select-none active:scale-95 shadow-2xs hover:scale-[1.01]"
                              style={{
                                backgroundColor: isToggled ? "#f0fdf4" : "#fafaf9",
                                borderColor: isToggled ? "#bbf7d0" : "#e2e2d8",
                                color: isToggled ? "#15803d" : "#57534e",
                              }}
                              title="Clicca per alternare tra l'età storica e l'età calcolata ad oggi"
                            >
                              <span className="text-xs">{isToggled ? "🔄" : "🌱"}</span>
                              {isToggled ? (
                                <span>
                                  Età della pianta ad oggi: <strong className="text-emerald-800 font-extrabold">{currentAgeOfPlant} giorni</strong> <span className="opacity-75 font-normal text-emerald-600">({daysPassed} gg passati da allora)</span>
                                </span>
                              ) : (
                                <span>
                                  Età della pianta al momento: <strong className="text-stone-800 font-extrabold">{ageAtMoment} giorni</strong> <span className="opacity-75 font-normal text-stone-500">(Clicca per aggiornare ad oggi 🕒)</span>
                                </span>
                              )}
                            </div>
                          );
                        })()}

                        {entry.imageUrl && (
                          <div className="mt-3 overflow-hidden rounded-xl border border-[#e2e2d8] max-w-[200px] cursor-zoom-in" onClick={() => setFullscreenImageUrl(entry.imageUrl)} title="Clicca per ingrandire">
                            <img src={entry.imageUrl} alt={entry.eventTitle} className="w-full h-auto object-cover max-h-32 transition duration-300 hover:scale-105" />
                          </div>
                        )}
                      </motion.div>
                    );
                  })}
                </div>
              </div>
              </>
            )
          ) : (
            <div className="bento-card flex items-center justify-center p-12 text-center text-sage-400 min-h-[400px]">
              <div>
                <Sprout className="w-12 h-12 mx-auto stroke-[1.2] opacity-40 mb-3" />
                <h3 className="font-serif italic text-lg">L'erbario è silente</h3>
                <p className="text-xs max-w-xs mt-1">Crea una nuova pianta premendo il tasto "Nuova Pianta" nell'erbario a sinistra.</p>
              </div>
            </div>
          )}
        </div>

        {/* COLONNA DESTRA PROMEMORIA: spans 3 */}
        <div className="lg:col-span-3 flex flex-col gap-6">
          <div className="bento-card p-5 bg-white space-y-4">
            {/* Header Calendario */}
            <div className="flex items-center justify-between pb-2 border-b border-[#e2e2d8]">
              <h3 className="text-xs font-mono uppercase tracking-widest text-[#2d3a27] font-bold flex items-center gap-1.5">
                <Calendar className="w-4 h-4 text-[#7e8c69]" />
                Agenda Prossimi Giorni
              </h3>
              <div className="flex items-center gap-1.5">
                {!isReadOnlyMode && (
                  <button
                    onClick={() => setIsAddActivityOpen(true)}
                    className="p-1 hover:bg-sage-50 text-sage-600 border border-[#e2e2d8] hover:border-sage-400 bg-white rounded-full cursor-pointer transition-all flex items-center justify-center"
                    title="Pianifica attività personalizzata"
                  >
                    <Edit className="w-3.5 h-3.5" />
                  </button>
                )}
                <span className="text-[10px] font-mono bg-[#7e8c69] rounded-full px-2.5 py-0.5 text-white font-semibold flex items-center justify-center">
                  {state.activities.filter(a => {
                    const p = state.plants.find(plant => plant.id === a.plantId);
                    return a.status === "todo" && (!p || !p.isDead) && (!selectedPlant || a.plantId === selectedPlant.id);
                  }).length}
                </span>
              </div>
            </div>

            {/* Lista Attività */}
            <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
              {state.activities.filter(a => {
                const p = state.plants.find(plant => plant.id === a.plantId);
                return a.status === "todo" && (!p || !p.isDead) && (!selectedPlant || a.plantId === selectedPlant.id);
              }).map(a => {
                const associatedPlant = state.plants.find(p => p.id === a.plantId);
                const isUrgent = a.priority === "alta";

                return (
                  <motion.div
                    key={a.id}
                    title={isReadOnlyMode ? "Serra in sola lettura" : "Tieni premuto per eliminare • Clicca per completare"}
                    onMouseDown={(e) => handleLongPressStart(e, a.id, "activity", a.title)}
                    onTouchStart={(e) => handleLongPressStart(e, a.id, "activity", a.title)}
                    onMouseUp={handleLongPressEnd}
                    onTouchEnd={handleLongPressEnd}
                    onMouseLeave={handleLongPressEnd}
                    onClick={(e) => handleElementClick(e, () => {
                      if (isReadOnlyMode) {
                        showToast("Sola visualizzazione: impossibile modificare i doveri.");
                        return;
                      }
                      handleToggleActivity(a.id);
                    })}
                    className={`p-3 rounded-2xl border cursor-pointer hover:bg-[#fff9f9]/40 hover:border-red-100 transition-all select-none active:scale-[0.98] flex items-start gap-2.5 ${
                      isUrgent ? "border-amber-200 bg-amber-50/10" : "border-[#e2e2d8] bg-white"
                    }`}
                  >
                    <div className="mt-0.5 text-sage-300 hover:text-[#7e8c69] transition-all flex items-center justify-center">
                      <Square className="w-4 h-4" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-1.5">
                        <h4 className="text-xs font-bold text-[#2d3a2e] leading-tight truncate flex-1">{a.title}</h4>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            startEditActivity(a.id, false);
                          }}
                          className="p-1 hover:bg-sage-100/60 text-sage-400 hover:text-indigo-600 transition-all rounded-lg cursor-pointer flex items-center justify-center bg-stone-50/50"
                          title="Modifica attività"
                        >
                          <Edit className="w-3 h-3" />
                        </button>
                      </div>
                      <p className="text-[9px] font-mono text-[#7e8c69] uppercase tracking-wider mt-0.5 truncate">
                        {associatedPlant ? associatedPlant.nickname : "Nota generica"}
                      </p>
                      
                      <div className="flex items-center justify-between gap-1 mt-1.5 text-[8px] font-mono">
                        <span className={`px-1.5 rounded-md font-bold text-[7px] uppercase tracking-wider ${
                          a.priority === "alta" ? "bg-red-50 text-red-700" :
                          a.priority === "media" ? "bg-amber-100 text-amber-800" :
                          "bg-slate-100 text-slate-700"
                        }`}>
                          {a.priority}
                        </span>

                        <div className="text-right flex flex-col items-end">
                          <span className="text-[#8e9299]">Scadenza: {a.dueDate}</span>
                          {(() => {
                            try {
                              const todayStr = new Date().toISOString().split("T")[0];
                              const tomorrow = new Date();
                              tomorrow.setDate(tomorrow.getDate() + 1);
                              const tomorrowStr = tomorrow.toISOString().split("T")[0];
                              if (a.dueDate === todayStr) {
                                return <span className="text-red-650 font-bold uppercase text-[7px] tracking-wider mt-0.5 animate-pulse bg-red-50 px-1 rounded">🔴 Scadenza oggi</span>;
                              } else if (a.dueDate === tomorrowStr) {
                                return <span className="text-amber-700 font-bold uppercase text-[7px] tracking-wider mt-0.5 bg-amber-50 px-1 rounded">🟡 Scadenza domani</span>;
                              }
                            } catch (_) {}
                            return null;
                          })()}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                );
              })}

              {state.activities.filter(a => {
                const p = state.plants.find(plant => plant.id === a.plantId);
                return a.status === "todo" && (!p || !p.isDead) && (!selectedPlant || a.plantId === selectedPlant.id);
              }).length === 0 && (
                <p className="text-xs text-sage-400 italic text-center py-8">Nessun dovere programmato per questa pianta.</p>
              )}
            </div>

            {/* Quick action buttons */}
            {!isReadOnlyMode && selectedPlant && (
              <div className="bg-[#f5f5f0] p-3 rounded-2xl border border-[#e2e2d8] space-y-2 mt-2">
                <p className="text-[10px] uppercase font-mono tracking-wider text-[#5a5a40] font-bold mb-1">
                  Pianifica per {selectedPlant.nickname}
                </p>
                <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                  <button
                    onClick={() => handleCreateActivity("annaffiatura", "Innaffia con acqua demineralizzata", "media")}
                    className="p-1.5 bg-white border border-[#e2e2d8] hover:border-blue-300 rounded-xl text-sage-850 font-medium transition-all text-left flex items-center gap-1 cursor-pointer"
                  >
                    <Droplet className="w-3 text-blue-500" /> Annaffia
                  </button>
                  <button
                    onClick={() => handleCreateActivity("concimazione", "Aggiungi concime potassio bio", "alta")}
                    className="p-1.5 bg-white border border-[#e2e2d8] hover:border-[#7e8c69] rounded-xl text-sage-850 font-medium transition-all text-left flex items-center gap-1 cursor-pointer"
                  >
                    <Sprout className="w-3 text-[#7e8c69]" /> Concima
                  </button>
                  <button
                    onClick={() => handleCreateActivity("pulizia", "Pulisci foglie da deposito", "bassa")}
                    className="p-1.5 bg-white border border-[#e2e2d8] hover:border-orange-300 rounded-xl text-sage-850 font-medium transition-all text-left flex items-center gap-1 cursor-pointer"
                  >
                    <FileText className="w-3 text-orange-500" /> Pulisci
                  </button>
                  <button
                    onClick={() => handleCreateActivity("ispezione", "Ispezione parassiti", "bassa")}
                    className="p-1.5 bg-white border border-[#e2e2d8] hover:border-[#2d3a27] rounded-xl text-sage-850 font-medium transition-all text-left flex items-center gap-1 cursor-pointer"
                  >
                    <Eye className="w-3 text-emerald-700" /> Ispeziona
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* STORICO RECENTE - MEMORIA STORICA COMPIUTA */}
          <div className="bento-card p-5 bg-white space-y-3">
            <h4 className="text-xs font-mono uppercase tracking-widest text-[#8e9299] font-bold">
              Memoria Storica Compiuta {selectedPlant ? ` di ${selectedPlant.nickname}` : ""}
            </h4>
            <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1 flex flex-col gap-1">
              {(() => {
                const completedList = state.activities.filter(a => a.status === "completed" && (!selectedPlant || a.plantId === selectedPlant.id));
                if (completedList.length === 0) {
                  return (
                    <p className="text-[11px] text-sage-400 italic text-center py-4">
                      {selectedPlant 
                        ? `Nessuna memoria storica compiuta per ${selectedPlant.nickname}.` 
                        : "Seleziona una pianta per vederne lo storico."}
                    </p>
                  );
                }
                return completedList.slice(0, 5).map(a => (
                  <div 
                    key={a.id} 
                    title={isReadOnlyMode ? "Cronologia in sola lettura" : "Tieni premuto per eliminare permanentemente"}
                    onMouseDown={(e) => handleLongPressStart(e, a.id, "completed-activity", a.title)}
                    onTouchStart={(e) => handleLongPressStart(e, a.id, "completed-activity", a.title)}
                    onMouseUp={handleLongPressEnd}
                    onTouchEnd={handleLongPressEnd}
                    onMouseLeave={handleLongPressEnd}
                    onClick={(e) => handleElementClick(e, () => {
                      showToast("Tieni premuto su questa faccenda chiusa per rimuoverla dallo storico biologico. 🏷️");
                    })}
                    className="p-3 bg-[#fafafa] hover:bg-red-50/10 hover:border-red-100 active:scale-[0.98] select-none transition-all cursor-pointer rounded-xl border border-[#e2e2d8] text-[10px] text-sage-600 space-y-1"
                  >
                    <div className="flex items-center justify-between gap-1.5 text-[#2d3a27] font-semibold uppercase text-[9px]">
                      <div className="flex items-center gap-1">
                        <CheckSquare className="w-3 h-3 text-[#7e8c69] flex-shrink-0" />
                        <span>{a.title}</span>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEditActivity(a.id, true);
                        }}
                        className="p-1 hover:bg-sage-100/60 text-sage-400 hover:text-indigo-600 transition-all rounded-lg cursor-pointer flex items-center justify-center bg-stone-50/50"
                        title="Modifica storico"
                      >
                        <Edit className="w-3 h-3" />
                      </button>
                    </div>
                    <p className="text-[9px] text-[#8e9299] font-mono">Chiusa il {a.completedAt ? new Date(a.completedAt).toLocaleDateString("it-IT") : ""}</p>
                    {a.completedNotes && <p className="italic font-serif whitespace-pre-wrap">« {a.completedNotes} »</p>}
                  </div>
                ));
              })()}
            </div>
          </div>
        </div>

      </main>

      {/* FOOTER */}
      <footer className="bento-card bg-white p-4 text-center text-[10px] font-mono tracking-wide text-sage-400 flex flex-col md:flex-row items-center justify-between px-6 gap-2">
        <p>© 2026 Flora - Botanical Digital Archive. Costruito con precisione e design Bento.</p>
        <div className="flex gap-4">
          {!isReadOnlyMode && (
            <button onClick={handleResetOrto} className="hover:text-red-500 transition-colors uppercase font-bold text-[9px] cursor-pointer">
              Azzera Orto / Carica Defaults
            </button>
          )}
          <span>Offline support & JSON backups</span>
        </div>
      </footer>

      {/* --- MODALE 1: IMPOSTAZIONI ORTO --- */}
      <AnimatePresence>
        {isSettingsOpen && (
          <div className="fixed inset-0 bg-black/30 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-3xl border border-[#e4e8e1] p-6 max-w-sm w-full space-y-4"
            >
              <div className="flex justify-between items-center pb-2 border-b border-[#e4e8e1]">
                <h3 className="font-serif font-bold text-[#2d3a2e] text-base">Flora Impostazioni</h3>
                <button onClick={() => setIsSettingsOpen(false)} className="p-1 hover:bg-[#e7ece5] rounded-xl"><X className="w-4 h-4" /></button>
              </div>

              <div className="space-y-3 text-xs text-sage-700">
                <div className="flex flex-col gap-1">
                  <label className="font-mono text-[10px] text-sage-400 uppercase">Nome Amministratore</label>
                  <input
                    type="text"
                    value={state.settings.userName}
                    onChange={e => setState({ ...state, settings: { ...state.settings, userName: e.target.value } })}
                    className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400 font-serif"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="font-mono text-[10px] text-sage-400 uppercase">Titolo Giardino / Orto</label>
                  <input
                    type="text"
                    value={state.settings.gardenName}
                    onChange={e => setState({ ...state, settings: { ...state.settings, gardenName: e.target.value } })}
                    className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400"
                  />
                </div>

                <div className="flex flex-col gap-1.5 pt-2 border-t border-[#e4e8e1]/70">
                  <label className="font-mono text-[10px] text-[#7e8c69] uppercase font-bold">Ruolo Accesso Dispositivo</label>
                  <div className="flex bg-[#f5f5f0] p-1 rounded-xl gap-1">
                    <button
                      type="button"
                      onClick={async () => {
                        setIsReadOnlyMode(true);
                        if (typeof window !== "undefined") {
                          localStorage.setItem("flora_auth_mode", "viewer");
                        }
                        showToast("Modalità Sola Lettura (Visualizzatore) Attivata 👁️");
                      }}
                      className={`flex-1 py-1.5 rounded-lg text-[10px] font-semibold text-center transition-all cursor-pointer ${isReadOnlyMode ? "bg-white text-[#2d3a27] shadow-xs" : "text-stone-400 hover:text-stone-600"}`}
                    >
                      Visualizzatore 👁️
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        setIsReadOnlyMode(false);
                        if (typeof window !== "undefined") {
                          localStorage.setItem("flora_auth_mode", "editor");
                        }
                        showToast("Modalità Scrittura (Editor) Sbloccata! 🌿✏️");
                      }}
                      className={`flex-1 py-1.5 rounded-lg text-[10px] font-semibold text-center transition-all cursor-pointer ${!isReadOnlyMode ? "bg-[#7e8c69] text-white shadow-xs" : "text-stone-400 hover:text-stone-600"}`}
                    >
                      Editor / Proprietario ✏️
                    </button>
                  </div>
                  <p className="text-[10px] text-stone-400 leading-relaxed">
                    Scegli <strong>Editor</strong> per salvare le modifiche in tempo reale nel Cloud di Firestore; usa <strong>Visualizzatore</strong> per condividere senza rischi.
                  </p>
                </div>

                <div className="pt-2 border-t border-[#e4e8e1]/70 space-y-2">
                  <p className="font-mono text-[10px] text-sage-400 uppercase">Importazione Manuale file JSON</p>
                  <input
                    type="file"
                    accept=".json"
                    onChange={e => {
                      const files = e.target.files;
                      if (files && files[0]) {
                        const r = new FileReader();
                        r.onload = async () => {
                          try {
                            const parsed = JSON.parse(r.result as string);
                            if (parsed.plants) {
                              setIsSettingsOpen(false);
                              await importAndSync(parsed, "JSON");
                            }
                          } catch (err) {
                            showToast("File JSON non valido.");
                          }
                        };
                        r.readAsText(files[0]);
                      }
                    }}
                    className="w-full text-xs text-sage-500 file:mr-2 file:py-1 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-sage-100 file:text-sage-800 hover:file:bg-sage-200"
                  />
                </div>
              </div>

              <div className="pt-2">
                <button
                  onClick={() => {
                    const json = JSON.stringify(state);
                    const blob = new Blob([json], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'flora_giardino_backup.json';
                    a.click();
                    URL.revokeObjectURL(url);
                    showToast("Esportata copia di riserva in JSON.");
                  }}
                  className="w-full py-2 bg-sage-50 hover:bg-sage-100 border border-sage-200 text-sage-800 rounded-xl text-xs font-semibold transition-all"
                >
                  Salva Copia Backup (.JSON)
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- MODALE 2: AGGIUNGI NUOVA PIANTA --- */}
      <AnimatePresence>
        {isAddPlantOpen && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-3xl border border-[#e4e8e1] p-6 max-w-lg w-full space-y-4 my-8"
            >
              <div className="flex justify-between items-center pb-2 border-b border-[#e4e8e1]">
                <h3 className="font-serif font-black text-[#2d3a2e] text-lg flex items-center gap-1.5">
                  <Sprout className="w-5 h-5 text-emerald-700" />
                  Metti a Dimora una Nuova Pianta
                </h3>
                <button onClick={() => setIsAddPlantOpen(false)} className="p-1 hover:bg-[#e7ece5] rounded-xl"><X className="w-4 h-4" /></button>
              </div>

              <form onSubmit={handleCreatePlant} className="space-y-4 text-xs text-sage-700">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[10px] text-sage-400 uppercase">Nome Scientifico *</label>
                    <input
                      type="text"
                      required
                      placeholder="es. Monstera Deliciosa, Strelitzia"
                      value={newPlantForm.name || ""}
                      onChange={e => setNewPlantForm({ ...newPlantForm, name: e.target.value })}
                      className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[10px] text-sage-400 uppercase">Soprannome Intimo *</label>
                    <input
                      type="text"
                      required
                      placeholder="es. Vortice Verde, Lyra, Aura"
                      value={newPlantForm.nickname || ""}
                      onChange={e => setNewPlantForm({ ...newPlantForm, nickname: e.target.value })}
                      className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[10px] text-sage-400 uppercase">Sotto-Famiglia / Ordine</label>
                    <input
                      type="text"
                      placeholder="es. Araceae, Cactaceae"
                      value={newPlantForm.species || ""}
                      onChange={e => setNewPlantForm({ ...newPlantForm, species: e.target.value })}
                      className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[10px] text-sage-400 uppercase">Metodo Provenienza / Origine</label>
                    <select
                      value={newPlantForm.origin}
                      onChange={e => setNewPlantForm({ ...newPlantForm, origin: e.target.value as PlantOrigin })}
                      className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400 bg-white"
                    >
                      <option value="acquisto">Acquistata da vivaio / mercato</option>
                      <option value="seme">Seminata / Germogliata da seme</option>
                      <option value="talea">Nata da Talea / Propagazione ad acqua</option>
                      <option value="trapianto">Trapianto / Innesto</option>
                      <option value="recupero">Salvata da incuria / Recuperata</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[10px] text-sage-400 uppercase">Stato Crescita Iniziale</label>
                    <select
                      value={newPlantForm.status}
                      onChange={e => setNewPlantForm({ ...newPlantForm, status: e.target.value as PlantStatus })}
                      className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400 bg-white"
                    >
                      <option value="crescita">Crescita attiva</option>
                      <option value="germoglio">Giovane germoglio</option>
                      <option value="stabile">Stabile</option>
                      <option value="fioritura">Florido / Fioritura</option>
                      <option value="stress">Stato di sofferenza / Stress</option>
                      <option value="recupero">In Recupero</option>
                      <option value="propagazione">Taleazione / Propagazione</option>
                    </select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[10px] text-sage-400 uppercase">Data di accoglienza</label>
                    <input
                      type="date"
                      value={newPlantForm.startDate || ""}
                      onChange={e => setNewPlantForm({ ...newPlantForm, startDate: e.target.value })}
                      className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400 font-mono"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="font-mono text-[10px] text-sage-400 uppercase">Descrizione / Storia della pianta</label>
                  <textarea
                    rows={2}
                    placeholder="Racconta brevemente dove l'hai trovata o perché desideri curarla..."
                    value={newPlantForm.description || ""}
                    onChange={e => setNewPlantForm({ ...newPlantForm, description: e.target.value })}
                    className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400 text-xs text-sage-700"
                  />
                </div>

                {/* IMAGES DRAG AND DROP & INPUT ENCODING */}
                <div className="space-y-1">
                  <label className="font-mono text-[10px] text-sage-400 uppercase block">Immagine Principale (Drag & Drop o Seleziona o URL)</label>
                  <div
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-2xl p-4 text-center cursor-pointer transition-colors flex flex-col items-center justify-center gap-1 ${
                      isDragging ? "border-emerald-500 bg-emerald-50/10" : "border-sage-300 hover:border-emerald-400 bg-[#fbfbf9]"
                    }`}
                  >
                    <Upload className="w-5 h-5 text-sage-400" />
                    <span className="text-[10px] font-medium text-sage-600">Trascina un'immagine qui o rileva file dispositivo</span>
                    <span className="text-[9px] text-sage-400 font-mono italic">Il file verrà incorporato offline al 100%</span>
                    <input
                      type="file"
                      ref={fileInputRef}
                      className="hidden"
                      accept="image/*"
                      onChange={handleFileChange}
                    />
                  </div>

                  <div className="flex flex-col gap-1 mt-1">
                    <span className="text-[9px] font-mono text-sage-400 uppercase">O incolla un link internet URL statico per l'immagine</span>
                    <input
                      type="text"
                      placeholder="https://images.unsplash.com/photo-..."
                      value={newPlantForm.imageUrl || ""}
                      onChange={e => setNewPlantForm({ ...newPlantForm, imageUrl: e.target.value })}
                      className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400 font-mono"
                    />
                  </div>

                  {newPlantForm.imageUrl && (
                    <div className="flex items-center gap-2 mt-2 p-2 bg-sage-50 rounded-xl">
                      <img src={newPlantForm.imageUrl} className="w-10 h-10 object-cover rounded-md border" />
                      <span className="text-[9px] text-sage-500 font-mono truncate max-w-xs">{newPlantForm.imageUrl}</span>
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-1">
                  <div className="flex justify-between items-center text-[10px] font-mono text-sage-400 uppercase">
                    <span>Valutazione livello salute</span>
                    <span className="font-bold text-sage-800">{newPlantForm.health ?? 100}%</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="100"
                    value={newPlantForm.health ?? 90}
                    onChange={e => setNewPlantForm({ ...newPlantForm, health: parseInt(e.target.value) })}
                    className="w-full h-1 bg-[#e7ece5] rounded-lg appearance-none cursor-pointer accent-sage-600"
                  />
                </div>

                {/* Tag list */}
                <div className="space-y-1">
                  <label className="font-mono text-[10px] text-sage-400 uppercase">Etichette / Tag Botanici</label>
                  <div className="flex gap-1.5 matches">
                    <input
                      type="text"
                      placeholder="Aggiungi tag (es. Interno, Ombra)"
                      value={draftTag}
                      onChange={e => setDraftTag(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleAddTag(); } }}
                      className="flex-1 p-2 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400"
                    />
                    <button
                      type="button"
                      onClick={handleAddTag}
                      className="p-2 bg-sage-100 hover:bg-sage-200 text-sage-800 rounded-xl font-mono text-[10px]"
                    >
                      Aggiungi
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {newPlantForm.tags?.map(t => (
                      <span key={t} className="bg-sage-50 hover:bg-red-50 text-sage-800 hover:text-red-700 p-0.5 px-2 rounded-md font-mono text-[9px] flex items-center gap-1 cursor-pointer transition-colors" onClick={() => handleRemoveTag(t)}>
                        {t} <X className="w-2.5 h-2.5" />
                      </span>
                    ))}
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full py-3 bg-gradient-to-tr from-sage-700 to-moss-600 hover:from-emerald-800 hover:to-moss-700 text-white font-serif font-black tracking-tight text-center rounded-2xl cursor-pointer shadow-md transition-all mt-4"
                >
                  Registra Diario Pianta
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- MODALE 3: MODIFICA PIANTA DISPONIBILE --- */}
      <AnimatePresence>
        {isEditPlantOpen && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-3xl border border-[#e4e8e1] p-6 max-w-lg w-full space-y-4 my-8"
            >
              <div className="flex justify-between items-center pb-2 border-b border-[#e4e8e1]">
                <h3 className="font-serif font-black text-[#2d3a2e] text-lg flex items-center gap-1.5">
                  <Edit className="w-4 h-4 text-emerald-700" />
                  Modifica Diario Pianta
                </h3>
                <button onClick={() => setIsEditPlantOpen(false)} className="p-1 hover:bg-[#e7ece5] rounded-xl"><X className="w-4 h-4" /></button>
              </div>

              <form onSubmit={handleEditPlant} className="space-y-4 text-xs text-sage-700">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[10px] text-sage-400 uppercase">Nome Scientifico *</label>
                    <input
                      type="text"
                      required
                      value={newPlantForm.name || ""}
                      onChange={e => setNewPlantForm({ ...newPlantForm, name: e.target.value })}
                      className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[10px] text-sage-400 uppercase">Soprannome Intimo *</label>
                    <input
                      type="text"
                      required
                      value={newPlantForm.nickname || ""}
                      onChange={e => setNewPlantForm({ ...newPlantForm, nickname: e.target.value })}
                      className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[10px] text-sage-400 uppercase">Sotto-Famiglia</label>
                    <input
                      type="text"
                      value={newPlantForm.species || ""}
                      onChange={e => setNewPlantForm({ ...newPlantForm, species: e.target.value })}
                      className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[10px] text-sage-400 uppercase">Metodo Provenienza / Origine</label>
                    <select
                      value={newPlantForm.origin}
                      onChange={e => setNewPlantForm({ ...newPlantForm, origin: e.target.value as PlantOrigin })}
                      className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none bg-white"
                    >
                      <option value="acquisto">Acquistata da vivaio / mercato</option>
                      <option value="seme">Seminata / Germogliata da seme</option>
                      <option value="talea">Nata da Talea / Propagazione ad acqua</option>
                      <option value="trapianto">Trapianto / Innesto</option>
                      <option value="recupero">Salvata da incuria / Recuperata</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[10px] text-sage-400 uppercase">Stato di crescita</label>
                    <select
                      value={newPlantForm.status}
                      onChange={e => setNewPlantForm({ ...newPlantForm, status: e.target.value as PlantStatus })}
                      className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none bg-white"
                    >
                      <option value="crescita">Crescita attiva</option>
                      <option value="germoglio">Giovane germoglio</option>
                      <option value="stabile">Stabile</option>
                      <option value="fioritura">Florido / fioritura</option>
                      <option value="stress">Stato di sofferenza / Stress</option>
                      <option value="recupero">In Recupero</option>
                      <option value="propagazione">Taleazione / Propagazione</option>
                    </select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[10px] text-sage-400 uppercase">Data di accoglienza</label>
                    <input
                      type="date"
                      value={newPlantForm.startDate || ""}
                      onChange={e => setNewPlantForm({ ...newPlantForm, startDate: e.target.value })}
                      className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="font-mono text-[10px] text-sage-400 uppercase">Descrizione / Storia della pianta</label>
                  <textarea
                    rows={2}
                    value={newPlantForm.description || ""}
                    onChange={e => setNewPlantForm({ ...newPlantForm, description: e.target.value })}
                    className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none text-xs"
                  />
                </div>

                {/* IMAGES DRAG AND DROP & INPUT ENCODING PER MODIFICA */}
                <div className="space-y-1">
                  <label className="font-mono text-[10px] text-sage-400 uppercase block">Immagine Principale (Drag & Drop o Seleziona o URL)</label>
                  <div
                    onDragOver={handleEditDragOver}
                    onDragLeave={handleEditDragLeave}
                    onDrop={handleEditDrop}
                    onClick={() => fileEditInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-2xl p-4 text-center cursor-pointer transition-colors flex flex-col items-center justify-center gap-1 ${
                      isDraggingEdit ? "border-emerald-500 bg-emerald-50/10" : "border-sage-300 hover:border-emerald-400 bg-[#fbfbf9]"
                    }`}
                  >
                    <Upload className="w-5 h-5 text-sage-400" />
                    <span className="text-[10px] font-medium text-sage-600">Trascina un'immagine qui o seleziona file dispositivo</span>
                    <span className="text-[9px] text-sage-400 font-mono italic">Il file verrà incorporato offline al 100%</span>
                    <input
                      type="file"
                      ref={fileEditInputRef}
                      className="hidden"
                      accept="image/*"
                      onChange={handleEditFileChange}
                    />
                  </div>

                  <div className="flex flex-col gap-1 mt-1">
                    <span className="text-[9px] font-mono text-sage-400 uppercase">O incolla un link internet URL statico per l'immagine</span>
                    <input
                      type="text"
                      placeholder="https://images.unsplash.com/photo-..."
                      value={newPlantForm.imageUrl || ""}
                      onChange={e => setNewPlantForm({ ...newPlantForm, imageUrl: e.target.value })}
                      className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400 font-mono"
                    />
                  </div>

                  {newPlantForm.imageUrl && (
                    <div className="flex items-center gap-2 mt-2 p-2 bg-sage-50 rounded-xl">
                      <img src={newPlantForm.imageUrl} className="w-10 h-10 object-cover rounded-md border" />
                      <span className="text-[9px] text-sage-500 font-mono truncate max-w-xs">{newPlantForm.imageUrl}</span>
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-1">
                  <div className="flex justify-between items-center text-[10px] font-mono text-sage-400 uppercase">
                    <span>Valutazione livello salute</span>
                    <span className="font-bold text-sage-800">{newPlantForm.health ?? 90}%</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="100"
                    value={newPlantForm.health ?? 90}
                    onChange={e => setNewPlantForm({ ...newPlantForm, health: parseInt(e.target.value) })}
                    className="w-full h-1 bg-[#e7ece5] rounded-lg appearance-none cursor-pointer accent-sage-600"
                  />
                </div>

                {/* Edit tag block */}
                <div className="space-y-1">
                  <label className="font-mono text-[10px] text-sage-400 uppercase">Etichette / Tag Botanici</label>
                  <div className="flex gap-1.5 matches">
                    <input
                      type="text"
                      placeholder="Aggiungi tag"
                      value={draftTag}
                      onChange={e => setDraftTag(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleAddTag(); } }}
                      className="flex-1 p-2 border border-[#e4e8e1] rounded-xl focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleAddTag}
                      className="p-2 bg-sage-100 hover:bg-sage-200 text-sage-800 rounded-xl"
                    >
                      Aggiungi
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {newPlantForm.tags?.map(t => (
                      <span key={t} className="bg-sage-50 hover:bg-red-50 text-sage-800 hover:text-red-700 p-0.5 px-2 rounded-md font-mono text-[9px] flex items-center gap-1 cursor-pointer transition-colors" onClick={() => handleRemoveTag(t)}>
                        {t} <X className="w-2.5 h-2.5" />
                      </span>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
                  <button
                    type="submit"
                    className="py-3 bg-sage-800 hover:bg-sage-900 text-white font-serif font-black tracking-tight text-center rounded-2xl cursor-pointer shadow-md transition-all text-xs"
                  >
                    Salva Modifiche Diario
                  </button>
                  <button
                    type="button"
                    onClick={handleEditPlantAndStoricize}
                    className="py-3 bg-emerald-700 hover:bg-emerald-800 text-white font-serif font-black tracking-tight text-center rounded-2xl cursor-pointer shadow-md transition-all text-xs"
                    title="Aggiorna la pianta e inserisci contemporaneamente una nuova nota di snapshot storica sul diario"
                  >
                    Modifica nuovo (Storicizza)
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- MODALE 4: AGGIUNGI NOTA DIARIO TIMELINE --- */}
      <AnimatePresence>
        {isNewDiaryOpen && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-3xl border border-[#e4e8e1] p-6 max-w-sm w-full space-y-4"
            >
              <div className="flex justify-between items-center pb-2 border-b border-[#e4e8e1]">
                <h3 className="font-serif font-bold text-[#2d3a2e] text-base flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-emerald-700" />
                  Registra Tappa di Crescita
                </h3>
                <button onClick={() => setIsNewDiaryOpen(false)} className="p-1 hover:bg-[#e7ece5] rounded-xl"><X className="w-4 h-4" /></button>
              </div>

              <form onSubmit={handleAddDiaryEntry} className="space-y-3 text-xs text-sage-700">
                <div className="flex flex-col gap-1">
                  <label className="font-mono text-[10px] text-sage-400 uppercase">Titolo Evento / Tappa *</label>
                  <input
                    type="text"
                    required
                    placeholder="Esempio: Spuntata foglia apicale, Rinvaso completato"
                    value={newDiaryForm.eventTitle}
                    onChange={e => setNewDiaryForm({ ...newDiaryForm, eventTitle: e.target.value })}
                    className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="font-mono text-[10px] text-sage-400 uppercase">Categoria Nota</label>
                  <select
                    value={newDiaryForm.category}
                    onChange={e => setNewDiaryForm({ ...newDiaryForm, category: e.target.value as any })}
                    className="p-2 border border-[#e4e8e1] rounded-xl bg-white"
                  >
                    <option value="osservazione">Osservazione generale</option>
                    <option value="evoluzione">Evoluzione / Nuove foglie / Germogli</option>
                    <option value="annaffiatura">Annaffiatura straordinaria</option>
                    <option value="concimazione">Alimentazione / Concime</option>
                    <option value="rinvaso">Rinvaso o Sviluppo di radici</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="font-mono text-[10px] text-sage-400 uppercase">Data e Ora dell'Evento</label>
                  <input
                    type="datetime-local"
                    value={toLocalDatetimeString(newDiaryForm.date || new Date().toISOString())}
                    onChange={e => {
                      const localVal = e.target.value;
                      const isoVal = localVal ? new Date(localVal).toISOString() : new Date().toISOString();
                      setNewDiaryForm({ ...newDiaryForm, date: isoVal });
                    }}
                    className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400 text-xs font-mono bg-white"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="font-mono text-[10px] text-sage-400 uppercase">Note narrative ed osservazioni *</label>
                  <textarea
                    rows={3}
                    required
                    placeholder="Descrivi se noti cambiamenti di tonalità, vigore o colore nelle foglie..."
                    value={newDiaryForm.notes}
                    onChange={e => setNewDiaryForm({ ...newDiaryForm, notes: e.target.value })}
                    className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none"
                  />
                </div>

                <div className="space-y-2 border-t border-[#f0f0e8] pt-2">
                  <span className="font-mono text-[10px] text-sage-400 uppercase block">Immagine (Opzionale)</span>
                  
                  {/* File Upload Selector */}
                  <div className="flex flex-col gap-1.5 font-mono">
                    <label className="flex items-center justify-center gap-2 p-2.5 border border-dashed border-[#c2c5be] hover:border-sage-500 rounded-xl bg-[#fafbfa] hover:bg-slate-50 cursor-pointer transition-all">
                      <Upload className="w-4 h-4 text-sage-500" />
                      <span className="text-[10px] font-bold text-sage-800 uppercase">SCEGLI FILE IMMAGINE</span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleDiaryFileChange}
                        className="hidden"
                      />
                    </label>
                  </div>

                  {/* Fallback Input URL */}
                  <div className="flex flex-col gap-1 font-mono">
                    <span className="text-[9px] text-center text-sage-400 uppercase">- oppure inserisci indirizzo URL -</span>
                    <input
                      type="text"
                      placeholder="https://images.unsplash.com/photo-..."
                      value={newDiaryForm.imageUrl}
                      onChange={e => setNewDiaryForm({ ...newDiaryForm, imageUrl: e.target.value })}
                      className="p-2 border border-[#e4e8e1] rounded-xl text-xs bg-[#fafbfa]"
                    />
                  </div>

                  {/* Immediate Preview */}
                  {newDiaryForm.imageUrl && (
                    <div className="mt-2 text-center font-mono">
                      <p className="text-[9px] text-sage-400 uppercase mb-1">Anteprima selezionata:</p>
                      <div className="w-full h-24 rounded-xl overflow-hidden border border-[#e2e2d8] bg-sage-50">
                        <img
                          src={newDiaryForm.imageUrl}
                          alt="Anteprima nota"
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setNewDiaryForm(prev => ({ ...prev, imageUrl: "" }))}
                        className="text-[9px] text-red-500 hover:underline mt-1 cursor-pointer"
                      >
                        Rimuovi immagine
                      </button>
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  className="w-full py-2.5 bg-gradient-to-tr from-sage-700 to-moss-600 hover:from-sage-800 hover:to-moss-700 text-white font-serif font-semibold tracking-tight text-center rounded-xl cursor-pointer shadow-sm transition-all"
                >
                  Registra nel Diario Vivo
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- MODALE 5: AGGIUNGI ATTIVITÀ PERSONALIZZATA --- */}
      <AnimatePresence>
        {isAddActivityOpen && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-3xl border border-[#e4e8e1] p-6 max-w-sm w-full space-y-4 font-sans"
            >
              <div className="flex justify-between items-center pb-2 border-b border-[#e4e8e1]">
                <h3 className="font-serif font-bold text-[#2d3a2e] text-base flex items-center gap-1.5">
                  <CalendarClock className="w-4 h-4 text-emerald-700" />
                  Pianifica Dovere Custom
                </h3>
                <button
                  type="button"
                  onClick={() => setIsAddActivityOpen(false)}
                  className="p-1 hover:bg-[#e7ece5] rounded-xl cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleAddCustomActivity} className="space-y-3 text-xs text-sage-700">
                <div className="flex flex-col gap-1">
                  <label className="font-mono text-[10px] text-sage-400 uppercase">Titolo Dovere / Promemoria *</label>
                  <input
                    type="text"
                    required
                    placeholder="Esempio: Rinvasare in argilla espansa"
                    value={newActivityForm.title}
                    onChange={e => setNewActivityForm({ ...newActivityForm, title: e.target.value })}
                    className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="font-mono text-[10px] text-sage-400 uppercase">Tipologia / Categoria (Opzionale)</label>
                  <select
                    value={newActivityForm.type}
                    onChange={e => setNewActivityForm({ ...newActivityForm, type: e.target.value as any })}
                    className="p-2 border border-[#e4e8e1] rounded-xl bg-white"
                  >
                    <option value="generale">Generica / Altro (Nessuna)</option>
                    <option value="annaffiatura">Annaffiatura</option>
                    <option value="concimazione">Concimazione</option>
                    <option value="ispezione">Ispezione foglie</option>
                    <option value="pulizia">Pulizia polvere o vasi</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="font-mono text-[10px] text-sage-400 uppercase">Priorità</label>
                  <select
                    value={newActivityForm.priority}
                    onChange={e => setNewActivityForm({ ...newActivityForm, priority: e.target.value as any })}
                    className="p-2 border border-[#e4e8e1] rounded-xl bg-white"
                  >
                    <option value="bassa">Bassa Priorità</option>
                    <option value="media">Media Priorità</option>
                    <option value="alta">Alta Priorità / Urgente</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="font-mono text-[10px] text-sage-400 uppercase">Data di Scadenza prevista</label>
                  <input
                    type="date"
                    value={newActivityForm.dueDate}
                    onChange={e => setNewActivityForm({ ...newActivityForm, dueDate: e.target.value })}
                    className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full py-2.5 bg-gradient-to-tr from-sage-700 to-moss-600 hover:from-sage-800 hover:to-moss-700 text-white font-serif font-semibold tracking-tight text-center rounded-xl cursor-pointer shadow-sm transition-all"
                >
                  Pianifica nella Serra
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- MODALE 6: CONFIRMATION CANCELLAZIONE PIANTA --- */}
      <AnimatePresence>
        {plantIdToDelete && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-3xl border border-[#e4e8e1] p-6 max-w-sm w-full space-y-4 font-sans"
            >
              <div className="flex justify-between items-center pb-2 border-b border-[#e4e8e1]">
                <h3 className="font-serif font-bold text-red-700 text-base flex items-center gap-1.5">
                  <Trash2 className="w-4 h-4" />
                  Rimuovi Pianta?
                </h3>
              </div>

              <div className="text-xs text-sage-700 leading-relaxed font-sans space-y-2">
                <p>Sei sicuro di voler rimuovere definitivamente questa pianta dal tuo erbario botanico?</p>
                <div className="font-bold text-red-700 bg-red-50 p-2.5 rounded-xl text-center">
                  Questa operazione rimuoverà anche l'intera timeline delle note inserite e non è reversibile.
                </div>
              </div>

              <div className="flex gap-2 pt-2 text-xs font-mono">
                <button
                  type="button"
                  onClick={() => setPlantIdToDelete(null)}
                  className="flex-1 py-2 bg-[#f5f5f0] hover:bg-[#e7ece5] text-sage-700 font-semibold rounded-xl cursor-pointer transition-all"
                >
                  Annulla
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const id = plantIdToDelete;
                    setPlantIdToDelete(null);
                    const remaining = state.plants.filter(p => p.id !== id);
                    setState(prev => ({ ...prev, plants: remaining }));
                    if (remaining.length > 0) {
                      setSelectedPlantId(remaining[0].id);
                    } else {
                      setSelectedPlantId("");
                    }
                    showToast("Diario rimosso dall'archivio botanico.");
                  }}
                  className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl cursor-pointer transition-all shadow-sm"
                >
                  Sì, Rimuovi
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- MODALE 8: REGISTRA DECESSO PIANTA --- */}
      <AnimatePresence>
        {isDeathModalOpen && plantIdToDeclareDead && (() => {
          const targetPlant = state.plants.find(p => p.id === plantIdToDeclareDead);
          if (!targetPlant) return null;
          return (
            <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
              <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                className="bg-white rounded-3xl border border-[#e4e8e1] p-6 max-w-sm w-full space-y-4 font-sans"
              >
                <div className="flex justify-between items-center pb-2 border-b border-[#e4e8e1]">
                  <h3 className="font-serif font-bold text-stone-700 text-base flex items-center gap-1.5">
                    <Skull className="w-4 h-4 text-stone-600" />
                    Addio a {targetPlant.name}
                  </h3>
                  <button
                    type="button"
                    onClick={() => {
                      setIsDeathModalOpen(false);
                      setPlantIdToDeclareDead(null);
                    }}
                    className="p-1 hover:bg-[#e7ece5] rounded-xl cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="text-xs text-sage-700 leading-relaxed font-sans space-y-2">
                  <p>Questo momento segna la fine del ciclo biologico attivo della tua pianta. Verrà spostata con rispetto nel **Memoriale Botanico**.</p>
                  <p className="text-stone-500 italic">
                    Puoi scrivere un pensiero d'addio, una causa del decesso o l'ultima lezione appresa per conservarla nel suo diario storico:
                  </p>
                </div>

                <div className="space-y-1">
                  <label className="font-mono text-[9px] text-stone-400 uppercase block select-none">Ultimo Saluto / Causa (Opzionale):</label>
                  <textarea
                    value={deathNotesInput}
                    onChange={(e) => setDeathNotesInput(e.target.value)}
                    rows={3}
                    className="w-full p-2.5 bg-[#f5f5f0] border border-[#e2e2d8] rounded-xl text-xs text-sage-800 placeholder-sage-400 focus:outline-none focus:ring-1 focus:ring-stone-400 resize-none font-sans"
                    placeholder="Esempio: Purtroppo un attacco improvviso di parassiti... Ha comunque rallegrato l'ufficio per mesi."
                  />
                </div>

                <div className="flex gap-2 pt-2 text-xs font-mono">
                  <button
                    type="button"
                    onClick={() => {
                      setIsDeathModalOpen(false);
                      setPlantIdToDeclareDead(null);
                    }}
                    className="flex-1 py-2 bg-[#f5f5f0] hover:bg-[#e7ece5] text-sage-700 font-semibold rounded-xl cursor-pointer transition-all"
                  >
                    Annulla
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      handleDeclareDeath(plantIdToDeclareDead, deathNotesInput);
                      setIsDeathModalOpen(false);
                      setPlantIdToDeclareDead(null);
                    }}
                    className="flex-1 py-2 bg-stone-700 hover:bg-stone-800 text-white font-bold rounded-xl cursor-pointer transition-all shadow-sm flex items-center justify-center gap-1"
                  >
                    <HeartOff className="w-3.5 h-3.5" />
                    Sancisci Addio
                  </button>
                </div>
              </motion.div>
            </div>
          );
        })()}
      </AnimatePresence>

      {/* --- MODALE 9: MEMORIALE BOTANICO COME PAGINA INTERA --- */}
      <AnimatePresence>
        {isMemorialOpen && (
          <motion.div
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", damping: 26, stiffness: 130 }}
            className="fixed inset-0 bg-[#fbfafa] z-50 overflow-y-auto w-full h-full flex flex-col font-sans"
          >
            {/* Header navigazione */}
            <header className="sticky top-0 bg-[#fbfafa]/95 backdrop-blur-md border-b border-[#e2e2d8] px-6 py-4 md:px-12 flex items-center gap-6 z-10 shadow-3xs">
              <button
                type="button"
                onClick={() => setIsMemorialOpen(false)}
                className="p-2 hover:bg-stone-100 rounded-full border border-stone-200 text-stone-700 cursor-pointer transition-all hover:scale-105 active:scale-95 flex items-center justify-center shadow-xs"
                title="Ritorna alla pagina principale"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-stone-150 bg-stone-100 text-stone-600 rounded-2xl border border-stone-200 shadow-2xs">
                  <Skull className="w-5 h-5 text-stone-600 animate-pulse" />
                </div>
                <div>
                  <h1 className="font-serif font-bold text-stone-800 text-xl md:text-2xl italic">Il Giardino della Memoria</h1>
                  <p className="text-[10px] md:text-xs font-mono uppercase tracking-widest text-[#8e9299]">Cure eterne delle specie passate</p>
                </div>
              </div>
            </header>

            {/* Contenuto diari piante passate */}
            <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-8 md:py-12 space-y-8">
              <div className="bg-gradient-to-r from-stone-50 to-stone-100 border border-stone-200 rounded-3xl p-6 md:p-8 flex flex-col md:flex-row items-center justify-between gap-6 shadow-3xs">
                <div className="space-y-2 max-w-2xl text-center md:text-left">
                  <h2 className="font-serif font-bold text-[#2d3a27] text-lg md:text-xl">Ricordare per non ripetere gli stessi errori</h2>
                  <p className="text-xs text-stone-600 leading-relaxed font-sans">
                    Il memoriale botanico custodisce la storia e lo storico diari di ogni pianta che ha concluso il suo cammino. L'erbario conserva qui la saggezza dei cicli naturali per guidare al meglio le colture attive della tua serra.
                  </p>
                </div>
                <div className="bg-white border border-stone-200 rounded-2xl p-4 flex gap-4 shrink-0 text-center font-mono">
                  <div>
                    <div className="text-2xl font-bold font-serif italic text-stone-800">{deadPlants.length}</div>
                    <div className="text-[8px] uppercase tracking-wider text-stone-400">Specie Storiche</div>
                  </div>
                  <div className="border-l border-stone-200"></div>
                  <div className="pl-4">
                    <div className="text-2xl font-bold font-serif italic text-[#7e8c69]">
                      {state.plants.filter(p => p.diary?.length > 1 && p.isDead).length}
                    </div>
                    <div className="text-[8px] uppercase tracking-wider text-stone-400">Diari Completi</div>
                  </div>
                </div>
              </div>

              {deadPlants.length === 0 ? (
                <div className="text-center py-20 border-2 border-dashed border-stone-250 rounded-3xl bg-stone-55/50 space-y-4">
                  <Heart className="w-14 h-14 mx-auto stroke-[1.2] text-stone-300 animate-pulse" />
                  <div className="space-y-1">
                    <h4 className="font-serif italic text-lg font-bold text-stone-700">Il giardino del silenzio è attualmente vuoto</h4>
                    <p className="text-xs max-w-md mx-auto leading-relaxed text-stone-500">
                      Tutti i tuoi diari botanici attivi splendono di vita. Se in futuro una pianta dovesse perdersi, spostala qui per custodirne il ricordo e lo storico delle lezioni apprese.
                    </p>
                  </div>
                  <button
                    onClick={() => setIsMemorialOpen(false)}
                    className="p-2 px-6 bg-stone-800 hover:bg-stone-900 font-mono text-xs text-white font-bold rounded-xl transition-all shadow-sm cursor-pointer"
                  >
                    Ritorna alla Serra Attiva
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {deadPlants.map(p => {
                    const totalNotes = p.diary?.length || 0;
                    return (
                      <motion.div 
                        key={p.id}
                        whileHover={{ y: -4 }}
                        className="bg-white rounded-3xl border border-stone-200 p-5 relative flex flex-col justify-between shadow-2xs hover:shadow-sm transition-all group"
                      >
                        <div className="space-y-4">
                          {/* Grayscale image option */}
                          <div className="w-full h-44 rounded-2xl overflow-hidden bg-stone-150 border border-stone-200 relative cursor-zoom-in" onClick={() => setFullscreenImageUrl(p.imageUrl)} title="Clicca per ingrandire">
                            <img 
                              src={p.imageUrl} 
                              alt={p.name} 
                              className="w-full h-full object-cover grayscale contrast-[1.08] blur-[0.3px] group-hover:grayscale-0 hover:scale-[1.06] transition-all duration-300"
                            />
                            <div className="absolute top-3 left-3 bg-[#fbfafa]/90 backdrop-blur-xs text-[9px] font-mono font-bold uppercase p-1 px-2.5 rounded-full text-stone-700 shadow-2xs border border-stone-200">
                              {p.species}
                            </div>
                          </div>

                          <div className="space-y-2">
                            <div className="flex justify-between items-baseline">
                              <h3 className="text-base font-bold text-stone-800 font-serif italic">{p.name}</h3>
                              <span className="text-[10px] font-mono text-stone-400 block">
                                {totalNotes} {totalNotes === 1 ? "nota" : "note"} nel diario
                              </span>
                            </div>

                            {p.nickname && (
                              <p className="text-[11px] font-mono text-[#7e8c69] italic">Soprannome: "{p.nickname}"</p>
                            )}

                            <div className="p-3.5 bg-stone-50 border border-stone-200 rounded-2xl text-[11px] leading-relaxed text-stone-600 font-sans italic relative">
                              <span className="font-semibold text-stone-400 font-mono text-[9px] uppercase block mb-1">Causa & Ricordo d'Addio:</span>
                              "{p.deathNotes || "Nessuna nota finale."}"
                            </div>
                          </div>
                        </div>

                        <div className="mt-6 pt-4 border-t border-stone-100 flex items-center justify-between text-[11px] text-stone-400 font-mono">
                          <span className="flex items-center gap-1">
                            <span className="text-stone-300">†</span> Spenta il {p.deathDate ? new Date(p.deathDate).toLocaleDateString("it-IT", { day: '2-digit', month: '2-digit', year: 'numeric' }) : ""}
                          </span>
                          <div className="flex gap-3">
                            <button
                              type="button"
                              onClick={() => {
                                handleRevivePlant(p.id);
                                setIsMemorialOpen(false);
                              }}
                              className="text-emerald-700 hover:text-emerald-950 font-bold cursor-pointer transition-colors"
                              title="Riporta questa pianta nella serra attiva"
                            >
                              Risuscita
                            </button>
                            <span className="text-stone-300">|</span>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedPlantId(p.id);
                                setIsMemorialOpen(false);
                                setTimeout(() => {
                                  detailsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                                }, 100);
                              }}
                              className="text-stone-700 hover:text-[#2d3a2e] font-bold cursor-pointer transition-colors"
                            >
                              Vedi Timeline
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </main>
          </motion.div>
        )}
      </AnimatePresence>

      {/* --- AGENDA DELLE COSE DA FARE E TRACCIATORI INTELLIGENTI COME PAGINA INTERA --- */}
      <AnimatePresence>
        {isAgendaOpen && (() => {
          const now = Date.now();
          const thirtyMinutes = 30 * 60 * 1000;

          // Trackers: non completati e non spuntati oggi (quelli completati o gestiti oggi si archiviano subito)
          const trackersList = state.smartTrackers || [];
          const todayStrForActive = new Date().toISOString().split("T")[0];
          const activeTrackersShown = trackersList.filter(t => !t.isCompleted && !(t.checkIns || []).includes(todayStrForActive));

          // Filtra attività generiche (globali, dove plantId === "global")
          const globalActivities = state.activities.filter(a => a.plantId === "global");
          // Attività globali: status !== "completed", oppure completate da meno di 30 minuti
          const activeGlobalActivitiesShown = globalActivities.filter(a => {
            if (a.status !== "completed") return true;
            if (!a.completedAt) return false;
            return (now - new Date(a.completedAt).getTime()) < thirtyMinutes;
          });

          return (
            <motion.div
              initial={{ opacity: 0, x: "100%" }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: "100%" }}
              transition={{ type: "spring", damping: 26, stiffness: 130 }}
              className="fixed inset-0 bg-[#fafbf9] z-50 overflow-y-auto w-full h-full flex flex-col font-sans"
            >
              {/* Header navigazione */}
              <header className="sticky top-0 bg-[#fafbf9]/95 backdrop-blur-md border-b border-stone-200 px-6 py-4 md:px-12 flex items-center justify-between z-10 shadow-3xs">
                <div className="flex items-center gap-6">
                  <button
                    type="button"
                    onClick={() => setIsAgendaOpen(false)}
                    className="p-2 hover:bg-emerald-50 rounded-full border border-emerald-100 text-emerald-800 cursor-pointer transition-all hover:scale-105 active:scale-95 flex items-center justify-center shadow-xs"
                    title="Ritorna alla pagina principale"
                  >
                    <ArrowLeft className="w-5 h-5" />
                  </button>
                  
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 bg-emerald-50 text-emerald-700 rounded-2xl border border-emerald-100 shadow-2xs">
                      <Calendar className="w-5 h-5 text-emerald-750 animate-pulse" />
                    </div>
                    <div>
                      <h1 className="font-serif font-bold text-[#2d3a27] text-xl md:text-2xl italic">Agenda Botanica & Culti</h1>
                      <p className="text-[10px] md:text-xs font-mono uppercase tracking-widest text-[#7e8c69]">Calendario globale ed evoluzioni intelligenti</p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setIsHistoryOpen(true)}
                    className="p-2 hover:bg-stone-100 rounded-xl border border-stone-200 text-stone-700 cursor-pointer transition-all hover:scale-105 active:scale-95 flex items-center justify-center gap-1.5 shadow-xs bg-white text-xs font-mono font-bold px-4 py-2"
                    title="Vedi lo storico delle attività e dei tracciatori completati"
                  >
                    <History className="w-4 h-4 text-emerald-800 animate-spin-slow" />
                    Storico
                  </button>

                  {!isReadOnlyMode && (
                    <button
                      type="button"
                      onClick={() => setIsAddTrackerOpen(true)}
                      className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white font-mono text-xs rounded-xl font-bold transition-all shadow-sm flex items-center gap-1.5 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Nuovo Tracciatore
                    </button>
                  )}
                </div>
              </header>

              {/* Contenuto principale dell'agenda suddiviso in due pannelli */}
              <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8 md:py-12 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                
                {/* PARTE SINISTRA: COSE DA FARE IN AMBITO BOTANICO (Spans 5) */}
                <div className="lg:col-span-5 space-y-6">
                  <div className="bento-card p-6 bg-white border border-stone-200 space-y-4">
                    <div className="flex justify-between items-center pb-2 border-b border-stone-100">
                      <div>
                        <h2 className="font-serif font-bold text-[#2d3a27] text-lg">Cose da Fare</h2>
                        <p className="text-[9px] font-mono uppercase tracking-wider text-sage-400">Doversi e faccende generali</p>
                      </div>
                      <span className="text-[9px] font-mono bg-emerald-100 text-emerald-800 rounded-lg px-2 py-0.5 font-bold">
                        {globalActivities.filter(a => a.status === "todo").length} attive
                      </span>
                    </div>

                    {/* Form incorporato per aggiungere un Todo globale al volo */}
                    {!isReadOnlyMode && (
                      <form 
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (agendaFormTitle.trim()) {
                            handleAddGlobalActivity(agendaFormTitle, agendaFormPriority, agendaFormDueDate);
                            setAgendaFormTitle("");
                          }
                        }}
                        className="bg-[#fafaf5] p-4 rounded-2xl border border-stone-150 space-y-3"
                      >
                        <h3 className="font-mono text-[9px] text-[#7e8c69] uppercase font-bold tracking-wider">Aggiungi nuova faccenda botanica</h3>
                        <div className="space-y-2">
                          <input
                            type="text"
                            required
                            value={agendaFormTitle}
                            onChange={(e) => setAgendaFormTitle(e.target.value)}
                            placeholder="Es. Prendere tre fiori di camomilla, Cambiare terriccio..."
                            className="w-full p-2.5 bg-white border border-stone-200 rounded-xl text-xs text-sage-800 focus:outline-none focus:ring-1 focus:ring-emerald-500 font-sans"
                          />
                          
                          <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                            <div>
                              <label className="text-[8px] text-stone-400 uppercase block mb-1">Priorità:</label>
                              <select
                                value={agendaFormPriority}
                                onChange={(e: any) => setAgendaFormPriority(e.target.value)}
                                className="w-full p-2 bg-white border border-stone-200 rounded-lg text-sage-800 focus:outline-none cursor-pointer"
                              >
                                <option value="bassa">Bassa</option>
                                <option value="media">Media</option>
                                <option value="alta">Alta</option>
                              </select>
                            </div>
                            <div>
                              <label className="text-[8px] text-stone-400 uppercase block mb-1">Scadenza:</label>
                              <input
                                type="date"
                                value={agendaFormDueDate}
                                onChange={(e) => setAgendaFormDueDate(e.target.value)}
                                className="w-full p-1.5 bg-white border border-stone-200 rounded-lg text-sage-800 focus:outline-none cursor-pointer"
                              />
                            </div>
                          </div>

                          <button
                            type="submit"
                            className="w-full py-2 bg-[#2d3a27] hover:bg-sage-900 text-white font-mono text-[10px] rounded-xl font-bold transition-all flex items-center justify-center gap-1 cursor-pointer shadow-xs"
                          >
                            <Plus className="w-3" /> Aggiungi alle cose da fare
                          </button>
                        </div>
                      </form>
                    )}

                    {/* Lista faccende botaniche */}
                    <div className="space-y-3 max-h-[460px] overflow-y-auto pr-1">
                      {activeGlobalActivitiesShown.length === 0 ? (
                        <div className="text-center py-10 text-stone-400 space-y-2">
                          <CheckSquare className="w-8 h-8 mx-auto text-stone-300 stroke-[1.2]" />
                          <p className="text-xs italic">Nessuna faccenda attiva inserita.</p>
                          <p className="text-[10px] text-stone-500 max-w-xs mx-auto">Le faccende completate scompaiono dall'elenco attivo dopo 30 minuti, ma restano visibili nello Storico in alto.</p>
                        </div>
                      ) : (
                        activeGlobalActivitiesShown.map(a => {
                          const isUrgent = a.priority === "alta";
                          return (
                            <div 
                              key={a.id}
                              className={`p-3 rounded-2xl border transition-all flex items-start gap-3 bg-white justify-between ${
                                a.status === "completed" 
                                  ? "border-stone-200 opacity-60" 
                                  : isUrgent 
                                    ? "border-red-150 bg-red-50/20 border-red-200" 
                                    : "border-stone-150 hover:border-emerald-200"
                              }`}
                            >
                              <div className="flex gap-2.5 items-start">
                                <button
                                  onClick={() => handleToggleActivity(a.id)}
                                  className="mt-0.5 text-stone-400 hover:text-[#7e8c69] transition-colors cursor-pointer"
                                  title={a.status === "completed" ? "Segna come da fare" : "Segna come completato"}
                                >
                                  {a.status === "completed" ? (
                                    <CheckSquare className="w-4 h-4 text-[#7e8c69]" />
                                  ) : (
                                    <Square className="w-4 h-4 text-stone-300" />
                                  )}
                                </button>
                                
                                <div className="space-y-0.5">
                                  <p className={`text-xs font-semibold leading-snug font-sans ${a.status === "completed" ? "line-through text-stone-400" : "text-[#2d3a27]"}`}>
                                    {a.title}
                                  </p>
                                  <div className="flex items-center gap-2 text-[8px] font-mono text-stone-400 uppercase tracking-wider">
                                    <span className={`p-0.5 px-1.5 rounded-full font-bold ${
                                      a.priority === "alta" 
                                        ? "bg-red-50 text-red-600" 
                                        : a.priority === "media" 
                                          ? "bg-amber-50 text-amber-700" 
                                          : "bg-blue-50 text-blue-600"
                                    }`}>
                                      {a.priority}
                                    </span>
                                    <span>• Scad. {new Date(a.dueDate).toLocaleDateString("it-IT", { day: '2-digit', month: '2-digit' })}</span>
                                    {(() => {
                                      try {
                                        const todayStr = new Date().toISOString().split("T")[0];
                                        const tomorrow = new Date();
                                        tomorrow.setDate(tomorrow.getDate() + 1);
                                        const tomorrowStr = tomorrow.toISOString().split("T")[0];
                                        if (a.dueDate === todayStr) {
                                          return <span className="text-red-600 font-extrabold animate-pulse bg-red-50/50 px-1 rounded">🔴 OGGI</span>;
                                        } else if (a.dueDate === tomorrowStr) {
                                          return <span className="text-amber-700 font-extrabold bg-amber-50 px-1 rounded">🟡 DOMANI</span>;
                                        }
                                      } catch (_) {}
                                      return null;
                                    })()}
                                  </div>
                                </div>
                              </div>

                              {!isReadOnlyMode && (
                                <button
                                  onClick={() => handleDeleteGlobalActivity(a.id)}
                                  className="p-1 hover:bg-stone-100 rounded-lg text-stone-450 hover:text-red-600 cursor-pointer transition-colors"
                                  title="Rimuovi faccenda"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>

                {/* PARTE DESTRA: TRACCIATORI EVOLUTIVI INTELLIGENTI (Spans 7) */}
                <div className="lg:col-span-7 space-y-6">
                  <div className="bg-gradient-to-br from-emerald-800 to-[#1b2618] text-white p-6 md:p-8 rounded-3xl border border-emerald-900 shadow-xl relative overflow-hidden">
                    {/* Sfondo botanico astratto */}
                    <div className="absolute right-0 bottom-0 opacity-10 select-none pointer-events-none">
                      <Sprout className="w-64 h-64 translate-x-12 translate-y-12" />
                    </div>

                    <div className="space-y-3 relative z-10">
                      <div className="inline-flex items-center gap-1.5 bg-emerald-700/60 backdrop-blur-xs p-1 px-3 rounded-full text-[10px] font-mono uppercase tracking-widest text-[#dfebd4] border border-emerald-600/40">
                        <Sparkles className="w-3 h-3 animate-spin" /> Sistema Calcolo Saggio automatico
                      </div>
                      <h2 className="font-serif italic font-bold text-2xl md:text-3xl text-[#fafbf9]">Propagazione & Culti Evolutivi</h2>
                      <p className="text-xs text-[#dfebd4] leading-relaxed max-w-xl font-sans">
                        Fissa un periodo calcolando istantaneamente il giorno del compimento e osserva il trascorrere dei giorni. Se lo spunti, lo stato temporale si congela alla data di fine. In caso contrario, il sistema acquisisce autonomamente il nuovo sorgere del sole aggiornando continuamente il conteggio!
                      </p>
                    </div>
                  </div>

                  {/* Lista dei Tracciatori Intelligenti */}
                  <div className="space-y-4">
                    <h3 className="font-serif font-bold text-[#2d3a27] text-lg flex items-center gap-2">
                      <Activity className="w-4.5 h-4.5 text-[#7e8c69] animate-pulse" />
                      Tracciatori Temporali di Ciclo
                    </h3>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {activeTrackersShown.length === 0 ? (
                        <div className="col-span-2 text-center py-12 bg-white rounded-3xl border border-stone-200 p-6 text-stone-400 space-y-2">
                          <Activity className="w-8 h-8 mx-auto text-stone-300 stroke-[1.2]" />
                          <p className="text-xs italic">Nessun tracciatore biologico attivo.</p>
                          <p className="text-[10px] text-stone-500 max-w-sm mx-auto">I tracciatori completati si archiviano immediatamente nello Storico in alto dopo il completamento.</p>
                        </div>
                      ) : (
                        activeTrackersShown.map(t => {
                          const effectiveStartDate = getEffectiveStartDate(t);
                          const elapsed = calculateElapsedDays(t);
                          const todayStr = new Date().toISOString().split("T")[0];
                          const todayChecked = (t.checkIns || []).includes(todayStr);
                          const progressPercent = Math.min(100, Math.round(((t.checkIns || []).length / t.durationDays) * 100));
                          const targetDateFormatted = calculateTargetDate(effectiveStartDate, t.durationDays);

                          return (
                            <div 
                              key={t.id}
                              className={`bg-white rounded-2xl border p-4 relative flex flex-col justify-between hover:border-emerald-300 transition-all shadow-3xs ${
                                t.isCompleted 
                                  ? "border-stone-150 bg-stone-50/40" 
                                  : "border-stone-200"
                              }`}
                            >
                              <div className="space-y-3">
                                <div className="flex justify-between items-start gap-2">
                                  <span className={`text-[8px] font-mono uppercase p-0.5 px-2 rounded-md ${
                                    t.isCompleted 
                                      ? "bg-stone-200 text-stone-600" 
                                      : "bg-emerald-100 text-emerald-800 font-bold"
                                  }`}>
                                    {t.isCompleted ? "Completato" : "In Corso"}
                                  </span>
                                  <div className="flex gap-2">
                                    <button
                                      onClick={() => handleToggleTracker(t.id)}
                                      className="p-1 hover:bg-[#e7ece5] rounded-xl cursor-pointer text-[#4c5938] hover:text-emerald-700 transition flex items-center gap-1.5"
                                      title={t.isCompleted ? "Tracciamento completato!" : todayChecked ? "Dovere già spuntato oggi" : "Spunta dovere di oggi"}
                                    >
                                      {t.isCompleted || todayChecked ? (
                                        <CheckSquare className="w-4 h-4 text-emerald-700 font-bold" />
                                      ) : (
                                        <Square className="w-4 h-4 text-stone-400" />
                                      )}
                                      {todayChecked && !t.isCompleted && (
                                        <span className="text-[8px] font-mono font-bold uppercase text-emerald-700 bg-emerald-50 px-1 rounded">fatto</span>
                                      )}
                                    </button>
                                    {!isReadOnlyMode && (
                                      <button
                                        onClick={() => handleDeleteTracker(t.id)}
                                        className="p-1 hover:bg-stone-100 rounded-xl cursor-pointer text-stone-400 hover:text-red-600 transition"
                                        title="Cancella tracciatore"
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </button>
                                    )}
                                  </div>
                                </div>

                              <div>
                                <h4 className={`text-sm font-bold font-serif italic ${t.isCompleted ? "text-stone-500 line-through" : "text-[#2d3a27]"}`}>
                                  {t.title}
                                </h4>
                                {t.notes && (
                                  <p className="text-[10px] text-stone-500 leading-normal line-clamp-2 mt-1 whitespace-pre-wrap">
                                    "{t.notes}"
                                  </p>
                                )}
                              </div>

                              {/* Progress metrics */}
                              <div className="space-y-1 bg-[#fbfbf9] p-2.5 border border-stone-150 rounded-xl font-sans">
                                <div className="flex justify-between text-[10px] font-mono">
                                  <span className="text-stone-500">Avanzamento:</span>
                                  <span className="font-bold text-[#2d3a27]">
                                    {t.isCompleted ? `Giorno ${elapsed} di ${t.durationDays} (Fermo)` : `Giorno ${elapsed} di ${t.durationDays}`}
                                  </span>
                                </div>

                                {/* Barra Grafica */}
                                <div className="w-full h-1.5 bg-stone-200 rounded-full overflow-hidden">
                                  <div 
                                    className={`h-full transition-all duration-550 ${t.isCompleted ? "bg-[#7e8c69]" : "bg-emerald-600"}`}
                                    style={{ width: `${progressPercent}%` }}
                                  />
                                </div>

                                <div className="flex justify-between items-center pt-1 text-[8px] font-mono text-stone-400 uppercase">
                                  <span>Inizio: {formatLocalDate(effectiveStartDate)}</span>
                                  <span className="font-bold text-emerald-800">Cura attiva fin: {targetDateFormatted}</span>
                                </div>
                              </div>
                            </div>

                            {/* Info autoregolazione automatica odierna */}
                            {!t.isCompleted && (
                              <div className="mt-2.5 pt-2 border-t border-dashed border-stone-100 text-[8px] font-mono text-emerald-700 flex items-center gap-1">
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-600 animate-pulse" />
                                Aggiornamento automatico attivo sul giorno odierno
                              </div>
                            )}
                          </div>
                        );
                      }))}
                    </div>
                  </div>
                </div>

              </main>

              {/* Modale interno inserimento Nuova Specie in Corso nell'Agenda */}
              <AnimatePresence>
                {isAddTrackerOpen && (
                  <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
                    <motion.div
                      initial={{ scale: 0.95, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0.95, opacity: 0 }}
                      className="bg-white rounded-3xl border border-[#e4e8e1] p-6 max-w-sm w-full space-y-4 font-sans"
                    >
                      <div className="flex justify-between items-center pb-2 border-b border-[#e4e8e1]">
                        <h3 className="font-serif font-bold text-emerald-800 text-base flex items-center gap-1.5">
                          <Plus className="w-4 h-4" />
                          Nuovo Tracciamento Temporale
                        </h3>
                        <button
                          type="button"
                          onClick={() => setIsAddTrackerOpen(false)}
                          className="p-1 hover:bg-[#e7ece5] rounded-xl cursor-pointer"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>

                      <form onSubmit={handleAddSmartTracker} className="space-y-3 font-sans text-xs">
                        <div className="space-y-1">
                          <label className="font-mono text-[9px] text-[#7e8c69] uppercase block select-none">Nome Processo / Specie:</label>
                          <input
                            type="text"
                            required
                            placeholder="Es. Talea di Rosa, Idrocultura Lavanda"
                            value={newTrackerForm.title}
                            onChange={(e) => setNewTrackerForm(prev => ({ ...prev, title: e.target.value }))}
                            className="w-full p-2.5 bg-[#fafaf5] border border-stone-250 border-stone-200 rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-500 text-xs text-sage-800"
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <label className="font-mono text-[9px] text-[#7e8c69] uppercase block select-none">Giorno d'Inizio:</label>
                            <input
                              type="date"
                              required
                              value={newTrackerForm.startDate}
                              onChange={(e) => setNewTrackerForm(prev => ({ ...prev, startDate: e.target.value }))}
                              className="w-full p-2 bg-[#fafaf5] border border-stone-250 border-stone-200 rounded-xl focus:outline-none text-xs text-sage-800 cursor-pointer"
                            />
                          </div>

                          <div className="space-y-1">
                            <label className="font-mono text-[9px] text-[#7e8c69] uppercase block select-none">Durata (Giorni):</label>
                            <input
                              type="number"
                              required
                              min={1}
                              max={365}
                              value={newTrackerForm.durationDays}
                              onChange={(e) => setNewTrackerForm(prev => ({ ...prev, durationDays: Number(e.target.value) || 21 }))}
                              className="w-full p-2 bg-[#fafaf5] border border-stone-250 border-stone-200 rounded-xl focus:outline-none text-xs text-sage-800"
                            />
                          </div>
                        </div>

                        <div className="space-y-1">
                          <label className="font-mono text-[9px] text-[#7e8c69] uppercase block select-none">Appunti / Note Metodo:</label>
                          <textarea
                            value={newTrackerForm.notes}
                            onChange={(e) => setNewTrackerForm(prev => ({ ...prev, notes: e.target.value }))}
                            rows={3}
                            placeholder="Inserisci istruzioni per la bagnatura o la collocazione..."
                            className="w-full p-2.5 bg-[#fafaf5] border border-stone-250 border-stone-200 rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-500 text-xs text-sage-800 resize-none"
                          />
                        </div>

                        <div className="flex gap-2 pt-2 text-xs font-mono">
                          <button
                            type="button"
                            onClick={() => setIsAddTrackerOpen(false)}
                            className="flex-1 py-2 bg-[#f5f5f0] hover:bg-[#e7ece5] text-sage-700 font-semibold rounded-xl cursor-pointer transition-all"
                          >
                            Annulla
                          </button>
                          <button
                            type="submit"
                            className="flex-1 py-2 bg-emerald-700 hover:bg-emerald-800 text-white font-bold rounded-xl cursor-pointer transition-all shadow-sm flex items-center justify-center gap-1"
                          >
                            <Check className="w-4 h-4" />
                            Attiva
                          </button>
                        </div>
                      </form>
                    </motion.div>
                  </div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* --- MODALE 8: STORICO GLOBALE ATTIVITA E CURE --- */}
      <AnimatePresence>
        {isHistoryOpen && (() => {
          const trackersList = state.smartTrackers || [];
          return (
            <div className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center p-4 z-[80]">
              <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                className="bg-white rounded-3xl border border-[#e4e8e1] p-6 max-w-2xl w-full max-h-[85vh] flex flex-col space-y-4 font-sans shadow-2xl"
              >
                <div className="flex justify-between items-center pb-2 border-b border-[#e4e8e1]">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-emerald-50 text-emerald-800 rounded-xl">
                      <History className="w-5 h-5 animate-pulse" />
                    </div>
                    <div>
                      <h3 className="font-serif font-bold text-[#2d3a27] text-base md:text-lg">
                        Storico delle Attività e Tracciatori
                      </h3>
                      <p className="text-[10px] font-mono text-stone-400 uppercase tracking-widest">Archivio completo e permanente delle voci concluse</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsHistoryOpen(false)}
                    className="p-1.5 hover:bg-[#e7ece5] rounded-xl text-stone-550 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Contenitore con scorrimento */}
                <div className="flex-1 overflow-y-auto space-y-6 pr-1 text-xs">
                  
                  {/* Sezione 1: Tracciatori di Ciclo Conclusi o Gestiti Oggi */}
                  <div className="space-y-3">
                    <h4 className="font-serif font-semibold text-emerald-850 text-sm border-b border-stone-100 pb-1 flex justify-between items-center">
                      <span>Tracciatori di Ciclo (In Archivio / Gestiti oggi)</span>
                      <span className="font-mono text-[9px] bg-stone-100 text-[#4c5938] px-2 py-0.5 rounded-md font-bold">
                        {trackersList.filter(t => t.isCompleted || (t.checkIns || []).includes(new Date().toISOString().split("T")[0])).length} voci
                      </span>
                    </h4>

                    {trackersList.filter(t => t.isCompleted || (t.checkIns || []).includes(new Date().toISOString().split("T")[0])).length === 0 ? (
                      <p className="text-center italic text-stone-400 py-4 font-sans">Nessun tracciatore in archivio o gestito oggi.</p>
                    ) : (
                      <div className="space-y-2">
                        {trackersList.filter(t => t.isCompleted || (t.checkIns || []).includes(new Date().toISOString().split("T")[0])).map(t => {
                          const effectiveStartDate = getEffectiveStartDate(t);
                          const elapsed = calculateElapsedDays(t);
                          const targetDate = calculateTargetDate(effectiveStartDate, t.durationDays);
                          const todayStr = new Date().toISOString().split("T")[0];
                          const todayChecked = (t.checkIns || []).includes(todayStr);
                          const progressPercent = Math.min(100, Math.round((elapsed / t.durationDays) * 100));

                          return (
                            <div key={t.id} className="bg-[#fafaf5] p-3 rounded-2xl border border-stone-150 flex flex-col gap-2">
                              <div className="flex items-start justify-between gap-3">
                                <div className="space-y-1">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className={`text-[8px] font-mono uppercase p-0.5 px-2 rounded-md font-bold ${
                                      t.isCompleted 
                                        ? "bg-stone-200 text-stone-600" 
                                        : "bg-emerald-100 text-emerald-800"
                                    }`}>
                                      {t.isCompleted ? "Completato" : "In Corso (Gestito oggi)"}
                                    </span>
                                    {todayChecked && !t.isCompleted && (
                                      <span className="text-[8px] font-mono font-bold uppercase text-emerald-700 bg-emerald-50 px-1 rounded border border-emerald-100">fatto</span>
                                    )}
                                  </div>
                                  <p className="font-bold text-[#2d3a27] font-serif italic text-sm">{t.title}</p>
                                  {t.notes && <p className="text-[10px] text-stone-500 italic whitespace-pre-wrap">"{t.notes}"</p>}
                                  <div className="text-[9px] font-mono text-stone-400 flex items-center gap-2 flex-wrap pt-1">
                                    <span className="bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded-md font-bold">Inizio: {formatLocalDate(effectiveStartDate)}</span>
                                    <span className="bg-stone-100 text-stone-600 px-1.5 py-0.5 rounded-md font-bold">Cura attiva fin: {targetDate}</span>
                                  </div>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  {/* Bottone per sbloccare/deselezionare anche dallo storico */}
                                  {!t.isCompleted && todayChecked && (
                                    <button
                                      onClick={() => handleToggleTracker(t.id)}
                                      className="p-1 hover:bg-[#e7ece5] text-[#4c5938] hover:text-red-700 rounded-lg cursor-pointer transition-colors"
                                      title="Riapri tracciamento (rimuovi spunta di oggi)"
                                    >
                                      <CheckSquare className="w-4 h-4 text-emerald-700 font-bold" />
                                    </button>
                                  )}
                                  {!isReadOnlyMode ? (
                                    <button
                                      onClick={() => handleDeleteTracker(t.id)}
                                      className="p-1 hover:bg-red-50 text-stone-400 hover:text-red-600 rounded-lg cursor-pointer transition-colors mt-0.5 flex-shrink-0"
                                      title="Elimina definitivamente"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  ) : (
                                    <span className="text-[8px] font-mono text-stone-400 uppercase self-start bg-stone-100 p-1 rounded-md">Solo Lettura</span>
                                  )}
                                </div>
                              </div>

                              {/* Progress bar anche nello storico */}
                              <div className="space-y-1 bg-white p-2 border border-stone-150 rounded-xl font-sans">
                                <div className="flex justify-between text-[10px] font-mono">
                                  <span className="text-stone-500 font-bold uppercase text-[8px] tracking-wider">Avanzamento temporale:</span>
                                  <span className="font-extrabold text-[#2d3a27]">
                                    {t.isCompleted ? `Giorno ${elapsed} di ${t.durationDays} (Fermo)` : `Giorno ${elapsed} di ${t.durationDays}`}
                                  </span>
                                </div>
                                <div className="w-full h-1 bg-stone-100 rounded-full overflow-hidden">
                                  <div 
                                    className={`h-full transition-all duration-550 ${t.isCompleted ? "bg-[#7e8c69]" : "bg-emerald-600"}`}
                                    style={{ width: `${progressPercent}%` }}
                                  />
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Sezione 2: Faccende & Attività Chiuse */}
                  <div className="space-y-3">
                    <h4 className="font-serif font-semibold text-emerald-850 text-sm border-b border-stone-100 pb-1 flex justify-between items-center">
                      <span>Svolte Botaniche / Faccende Chiuse</span>
                      <span className="font-mono text-[9px] bg-stone-100 text-[#4c5938] px-2 py-0.5 rounded-md font-bold">
                        {state.activities.filter(a => a.status === "completed").length} in archivio
                      </span>
                    </h4>

                    {state.activities.filter(a => a.status === "completed").length === 0 ? (
                      <p className="text-center italic text-stone-400 py-4 font-sans">Nessuna faccenda completata in archivio.</p>
                    ) : (
                      <div className="space-y-2">
                        {state.activities.filter(a => a.status === "completed").map(a => {
                          const associatedPlant = state.plants.find(p => p.id === a.plantId);
                          const plantLabel = associatedPlant 
                            ? `${associatedPlant.name} ${associatedPlant.nickname ? `(« ${associatedPlant.nickname} »)` : ""}`
                            : "Faccenda Generale";
                          return (
                            <div key={a.id} className="bg-[#fafaf5] p-3 rounded-2xl border border-stone-150 flex items-start justify-between gap-3 shadow-3xs transition hover:border-[#7e8c69]/40">
                              <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <span className="bg-emerald-100 text-emerald-800 text-[8px] font-mono px-1 rounded-sm uppercase font-bold">Spuntata</span>
                                  <p className="font-semibold text-stone-650 line-through text-xs font-sans">{a.title}</p>
                                </div>
                                <p className="text-[9px] text-[#7e8c69] font-serif italic">Relativa a: {plantLabel}</p>
                                <div className="text-[9px] font-mono text-stone-400 flex items-center gap-2 flex-wrap">
                                  <span>Priorità: {a.priority}</span>
                                  <span>• Scadenza prevista: {a.dueDate}</span>
                                  {a.completedAt && <span>• Completata: {new Date(a.completedAt).toLocaleDateString("it-IT")}</span>}
                                </div>
                              </div>
                              {!isReadOnlyMode ? (
                                <button
                                  onClick={() => handleDeleteGlobalActivity(a.id)}
                                  className="p-1 hover:bg-red-50 text-stone-400 hover:text-red-700 cursor-pointer transition-colors mt-0.5 flex-shrink-0"
                                  title="Elimina definitivamente dallo storico"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              ) : (
                                <span className="text-[8px] font-mono text-stone-400 uppercase self-start bg-stone-100 p-1 rounded-md">Solo Lettura</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                </div>

                <div className="pt-2 border-t border-[#e4e8e1] flex justify-between items-center">
                  <div>
                    {!isReadOnlyMode && (state.activities.filter(a => a.status === "completed").length > 0 || trackersList.filter(t => t.isCompleted).length > 0) && (
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm("Sei sicuro di voler svuotare interamente lo storico? Tutti i tracciatori e le faccende completate verranno eliminati permanentemente.")) {
                            setState(prev => ({
                              ...prev,
                              activities: prev.activities.filter(a => a.status !== "completed"),
                              smartTrackers: (prev.smartTrackers || []).filter(t => !t.isCompleted)
                            }));
                            showToast("Storico interamente svuotato! 🧹🍃");
                          }
                        }}
                        className="px-3.5 py-2 bg-red-50 hover:bg-red-150 active:scale-95 text-red-700 font-mono text-xs rounded-xl font-bold cursor-pointer transition-all border border-red-200/50 flex items-center gap-1.5"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Svuota Storico
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsHistoryOpen(false)}
                    className="px-4 py-2 bg-emerald-850 hover:bg-emerald-900 text-white font-mono text-xs rounded-xl font-bold cursor-pointer transition-all shadow-sm"
                  >
                    Chiudi Storico
                  </button>
                </div>
              </motion.div>
            </div>
          );
        })()}
      </AnimatePresence>

      {/* --- MODALE 7: CONDIVISIONE LINK COPIA STATO --- */}
      <AnimatePresence>
        {isShareOpen && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-3xl border border-[#e4e8e1] p-6 max-w-md w-full space-y-4 font-sans"
            >
              <div className="flex justify-between items-center pb-2 border-b border-[#e4e8e1]">
                <h3 className="font-serif font-bold text-[#2d3a2e] text-base flex items-center gap-1.5">
                  <Share2 className="w-4 h-4 text-emerald-700" />
                  Condividi la tua Serra
                </h3>
                <button
                  type="button"
                  onClick={() => setIsShareOpen(false)}
                  className="p-1 hover:bg-[#e7ece5] rounded-xl cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="text-xs text-sage-700 leading-relaxed font-sans space-y-2">
                <p>
                  Questo è il link unico del diario botanico cloud. Chiunque apra questo indirizzo vedrà la tua serra in tempo reale in **modalità visualizzatore** (sola lettura), perfettamente aggiornata con i tuoi ultimi diari, piante e foto!
                </p>
              </div>

              <div className="space-y-2">
                <label className="font-mono text-[10px] text-sage-400 uppercase block select-none">Link Unico del Diario:</label>
                <div className="flex flex-col gap-2">
                  <textarea
                    readOnly
                    value={generatedShareUrl}
                    onFocus={(e) => e.target.select()}
                    onClick={(e) => {
                      (e.target as HTMLTextAreaElement).select();
                    }}
                    rows={4}
                    className="w-full p-2.5 bg-[#f5f5f0] border border-[#e2e2d8] rounded-xl font-mono text-[10px] text-sage-800 focus:outline-none focus:ring-1 focus:ring-sage-400 resize-none select-all cursor-pointer"
                    placeholder="Generando link..."
                  />
                  <p className="text-[9px] text-[#2d3a2e] font-mono italic select-none">
                    💡 Clicca sopra al testo per selezionarlo interamente o usa il pulsante qui sotto.
                  </p>
                </div>
              </div>

              <div className="flex gap-2 pt-2 text-xs font-mono">
                <button
                  type="button"
                  onClick={() => setIsShareOpen(false)}
                  className="flex-1 py-2.5 bg-[#f5f5f0] hover:bg-[#e7ece5] text-sage-700 font-semibold rounded-xl cursor-pointer transition-all"
                >
                  Chiudi
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                      navigator.clipboard.writeText(generatedShareUrl)
                        .then(() => {
                          setIsCopiedSuccess(true);
                          showToast("Copiato di nuovo negli appunti!");
                          setTimeout(() => setIsCopiedSuccess(false), 2000);
                        })
                        .catch(() => {
                          showToast("Assicurati di selezionare manualmente il testo.");
                        });
                    } else {
                      showToast("Assicurati di selezionare manualmente il testo.");
                    }
                  }}
                  className={`flex-1 py-2.5 font-bold rounded-xl cursor-pointer transition-all shadow-sm flex items-center justify-center gap-1.5 ${
                    isCopiedSuccess
                      ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                      : "bg-[#2d3a2e] hover:bg-sage-900 text-white"
                  }`}
                >
                  {isCopiedSuccess ? (
                    <>
                      <Check className="w-4 h-4" />
                      Copiato!
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copia Link
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
 
      {/* --- MODALE 10: CONFERMA RIMOZIONE ELEMENTO (LONG PRESS) --- */}
      <AnimatePresence>
        {deleteConfirmItem && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 z-[80]">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-3xl border border-[#e4e8e1] p-6 max-w-sm w-full space-y-4 shadow-2xl font-sans"
            >
              <div className="flex items-center gap-3 pb-2 border-b border-stone-100">
                <div className="p-2 bg-red-50 text-red-600 rounded-xl">
                  <Trash2 className="w-5 h-5 animate-pulse" />
                </div>
                <div>
                  <h3 className="font-serif font-bold text-stone-850 text-sm">Rimuovere elemento?</h3>
                  <p className="text-[9px] font-mono text-stone-400 uppercase tracking-wider">Azione Irreversibile</p>
                </div>
              </div>

              <div className="space-y-2 text-xs text-[#5a5a40]">
                <p>Vuoi eliminare definitivamente questa voce?</p>
                <div className="p-3 bg-[#fafaf5] rounded-xl border border-stone-150 italic font-medium font-serif text-[#2d3a27] text-left">
                  "{deleteConfirmItem.title}"
                </div>
                <p className="text-[10px] text-stone-400 font-mono text-left">
                  {deleteConfirmItem.type === "diary" 
                    ? "La nota sarà rimossa permanentemente dalla cronologia biologica della pianta." 
                    : deleteConfirmItem.type === "completed-activity"
                    ? "La faccenda completata sparirà per sempre dallo storico."
                    : "L'attività programmata sarà cancellata dall'agenda dei prossimi giorni della pianta."}
                </p>
              </div>

              <div className="grid grid-cols-3 gap-1 pt-2">
                <button
                  type="button"
                  onClick={() => setDeleteConfirmItem(null)}
                  className="py-2.5 bg-stone-100 hover:bg-stone-200 text-stone-700 font-mono text-[9px] rounded-xl font-bold transition-all cursor-pointer text-center"
                >
                  Annulla
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const item = deleteConfirmItem;
                    setDeleteConfirmItem(null);
                    if (item.type === "diary" && item.parentPlantId) {
                      startEditDiary(item.id, item.parentPlantId);
                    } else if (item.type === "completed-activity") {
                      startEditActivity(item.id, true);
                    } else {
                      startEditActivity(item.id, false);
                    }
                  }}
                  className="py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-mono text-[9px] rounded-xl font-bold transition-all cursor-pointer text-center flex items-center justify-center gap-1"
                >
                  <Edit className="w-2.5 h-2.5" /> Modifica
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const item = deleteConfirmItem;
                    setDeleteConfirmItem(null); // Chiude subito la modale con fluidità
                    if (item.type === "diary" && item.parentPlantId) {
                      handleDeleteDiaryEntry(item.parentPlantId, item.id);
                    } else {
                      handleDeleteGlobalActivity(item.id);
                    }
                  }}
                  className="py-2.5 bg-red-600 hover:bg-red-700 text-white font-mono text-[9px] rounded-xl font-bold transition-all cursor-pointer text-center"
                >
                  Sì, Elimina
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- MODALE 12: MODIFICA ELEMENTO SELEZIONATO --- */}
      <AnimatePresence>
        {editingItem && (
          <div className="fixed inset-0 bg-stone-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-[90]">
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 10 }}
              className="bg-white rounded-3xl border border-[#e4e8e1] p-6 max-w-md w-full space-y-4 shadow-2xl font-sans text-xs text-sage-800"
            >
              <div className="flex items-center justify-between pb-3 border-b border-stone-100">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
                    <Edit className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-serif font-bold text-stone-850 text-sm">Modifica Elemento</h3>
                    <p className="text-[9px] font-mono text-indigo-500 uppercase tracking-wider font-semibold">
                      {editingItem.type === "diary" ? "Nota di Diario" : "Attività Botanica"}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setEditingItem(null)}
                  className="p-1 hover:bg-stone-100 rounded-lg text-stone-400 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleSaveEdit} className="space-y-4">
                {/* Campo Titolo / EventTitle */}
                <div className="space-y-1">
                  <label className="block text-stone-600 font-bold uppercase text-[9px] tracking-wider font-mono">
                    Titolo / Nome
                  </label>
                  <input
                    type="text"
                    value={editingItem.title}
                    onChange={(e) => setEditingItem({ ...editingItem, title: e.target.value })}
                    className="w-full bg-[#fcfcf9] p-2.5 rounded-xl border border-[#e2e2d8] focus:border-[#2d3a27] focus:outline-hidden text-xs text-stone-800"
                    placeholder="Es. Irrigazione straordinaria"
                    required
                  />
                </div>

                {/* Se è una nota del diario, mostriamo il campo Note e Categoria */}
                {editingItem.type === "diary" && (
                  <>
                    <div className="space-y-1">
                      <label className="block text-stone-600 font-bold uppercase text-[9px] tracking-wider font-mono">
                        Categoria Nota
                      </label>
                      <select
                        value={editingItem.category || "osservazione"}
                        onChange={(e) => setEditingItem({ ...editingItem, category: e.target.value })}
                        className="w-full bg-[#fcfcf9] p-2.5 rounded-xl border border-[#e2e2d8] focus:border-[#2d3a27] focus:outline-hidden text-xs text-stone-800 cursor-pointer"
                      >
                        <option value="osservazione">👁️ Osservazione</option>
                        <option value="irrigazione">💧 Irrigazione / Acqua</option>
                        <option value="concimazione">🧪 Concimazione</option>
                        <option value="rinvaso">🪴 Rinvaso biologico</option>
                        <option value="potatura">✂️ Potatura rami</option>
                        <option value="trattamento">🛡️ Trattamento parassiti</option>
                        <option value="fioritura">🌸 Svolta fioritura</option>
                        <option value="raccolto">🍎 Raccolto frutti</option>
                        <option value="morte">💀 Segnale di appassimento/morte</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="block text-stone-600 font-bold uppercase text-[9px] tracking-wider font-mono">
                        Testo Dettagliato
                      </label>
                      <textarea
                        value={editingItem.notes || ""}
                        onChange={(e) => setEditingItem({ ...editingItem, notes: e.target.value })}
                        rows={4}
                        className="w-full bg-[#fcfcf9] p-2.5 rounded-xl border border-[#e2e2d8] focus:border-[#2d3a27] focus:outline-hidden text-xs text-stone-800 leading-relaxed font-sans"
                        placeholder="Descrivi cosa hai osservato o fatto in dettaglio..."
                        required
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-stone-600 font-bold uppercase text-[9px] tracking-wider font-mono">
                        URL Immagine (Opzionale)
                      </label>
                      <input
                        type="url"
                        value={editingItem.imageUrl || ""}
                        onChange={(e) => setEditingItem({ ...editingItem, imageUrl: e.target.value })}
                        className="w-full bg-[#fcfcf9] p-2.5 rounded-xl border border-[#e2e2d8] focus:border-[#2d3a27] focus:outline-hidden text-xs text-stone-800"
                        placeholder="https://images.unsplash.com/..."
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-stone-600 font-bold uppercase text-[9px] tracking-wider font-mono">
                        Data e Ora di Creazione
                      </label>
                      <input
                        type="datetime-local"
                        value={toLocalDatetimeString(editingItem.date || "")}
                        onChange={(e) => {
                          const localVal = e.target.value;
                          const isoVal = localVal ? new Date(localVal).toISOString() : new Date().toISOString();
                          setEditingItem({ ...editingItem, date: isoVal });
                        }}
                        className="w-full bg-[#fcfcf9] p-2.5 rounded-xl border border-[#e2e2d8] focus:border-[#2d3a27] focus:outline-hidden text-xs text-stone-800"
                      />
                    </div>
                  </>
                )}

                {/* Se è un'attività (attiva o completata), mostriamo campi Categoria Attività, Scadenza, Priorità */}
                {editingItem.type !== "diary" && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="block text-stone-600 font-bold uppercase text-[9px] tracking-wider font-mono">
                          Tipo Attività
                        </label>
                        <select
                          value={editingItem.activityType || "generale"}
                          onChange={(e) => setEditingItem({ ...editingItem, activityType: e.target.value })}
                          className="w-full bg-[#fcfcf9] p-2.5 rounded-xl border border-[#e2e2d8] focus:border-[#2d3a27] focus:outline-hidden text-xs text-stone-800 cursor-pointer"
                        >
                          <option value="irrigazione">💧 Irrigazione</option>
                          <option value="concimazione">🧪 Concimazione</option>
                          <option value="rinvaso">🪴 Rinvaso</option>
                          <option value="potatura">✂️ Potatura</option>
                          <option value="pulizia">🧹 Pulizia foglie</option>
                          <option value="ispezione">🔍 Ispezione</option>
                          <option value="generale">🌱 Generale</option>
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="block text-stone-600 font-bold uppercase text-[9px] tracking-wider font-mono">
                          Priorità
                        </label>
                        <select
                          value={editingItem.priority || "media"}
                          onChange={(e) => setEditingItem({ ...editingItem, priority: e.target.value as "bassa" | "media" | "alta" })}
                          className="w-full bg-[#fcfcf9] p-2.5 rounded-xl border border-[#e2e2d8] focus:border-[#2d3a27] focus:outline-hidden text-xs text-stone-800 cursor-pointer"
                        >
                          <option value="bassa">🟢 Bassa priority</option>
                          <option value="media">🟡 Media priority</option>
                          <option value="alta">🔴 Alta priority</option>
                        </select>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="block text-stone-600 font-bold uppercase text-[9px] tracking-wider font-mono">
                        Data Scadenza
                      </label>
                      <input
                        type="date"
                        value={editingItem.dueDate || ""}
                        onChange={(e) => setEditingItem({ ...editingItem, dueDate: e.target.value })}
                        className="w-full bg-[#fcfcf9] p-2.5 rounded-xl border border-[#e2e2d8] focus:border-[#2d3a27] focus:outline-hidden text-xs text-stone-800"
                        required
                      />
                    </div>
                  </>
                )}

                {/* Bottoni Salva / Chiudi */}
                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-stone-100">
                  <button
                    type="button"
                    onClick={() => setEditingItem(null)}
                    className="py-2.5 bg-stone-100 hover:bg-stone-200 text-stone-700 font-mono text-[10px] rounded-xl font-bold transition-all cursor-pointer text-center"
                  >
                    Annulla
                  </button>
                  <button
                    type="submit"
                    className="py-2.5 bg-[#2d3a27] hover:bg-[#1a2318] text-white font-mono text-[10px] rounded-xl font-bold transition-all cursor-pointer text-center"
                  >
                    Salva Modifiche
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- POPUP DA LONG PRESS SU PIANTA --- */}
      <AnimatePresence>
        {longPressedPlant && (
          <div className="fixed inset-0 bg-black/45 backdrop-blur-xs flex items-center justify-center p-4 z-[95]">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-3xl border border-[#e4e8e1] p-5 max-w-xs w-full space-y-4 shadow-2xl font-sans"
            >
              <div className="text-center pb-2 border-b border-stone-100">
                <h3 className="font-serif font-bold text-[#2d3a27] text-sm">Opzioni Pianta</h3>
                <p className="text-[10px] text-sage-400 font-mono italic">« {longPressedPlant.nickname} »</p>
              </div>

              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const plant = longPressedPlant;
                    setLongPressedPlant(null);
                    // Seleziona la pianta prima
                    setSelectedPlantId(plant.id);
                    // Popola il form
                    setNewPlantForm({
                      name: plant.name,
                      nickname: plant.nickname,
                      species: plant.species,
                      origin: plant.origin,
                      startDate: plant.startDate,
                      description: plant.description,
                      imageUrl: plant.imageUrl,
                      status: plant.status,
                      health: plant.health,
                      notes: plant.notes,
                      tags: plant.tags
                    });
                    setIsEditPlantOpen(true);
                  }}
                  className="w-full py-2.5 bg-emerald-700 hover:bg-emerald-800 text-white font-mono text-xs rounded-xl font-bold cursor-pointer transition-all flex items-center justify-center gap-2 shadow-xs"
                >
                  <Edit className="w-3.5 h-3.5" /> Modifica Pianta
                </button>

                <div className="border-t border-b border-stone-100 py-2.5 space-y-1.5">
                  <div className="text-[10px] font-mono text-sage-400 font-bold uppercase tracking-wider text-center">Organizza Posizione</div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => movePlant(longPressedPlant.id, "up")}
                      className="flex-1 py-2 bg-stone-100 hover:bg-stone-200 text-[#2d3a27] font-mono text-xs rounded-xl font-bold cursor-pointer transition-all flex items-center justify-center gap-1.5 border border-[#e2e2d8] active:scale-95"
                      title="Sposta in alto nella serra"
                    >
                      <ArrowUp className="w-3.5 h-3.5 text-sage-600 animate-bounce" /> Sposta Su
                    </button>
                    <button
                      type="button"
                      onClick={() => movePlant(longPressedPlant.id, "down")}
                      className="flex-1 py-2 bg-stone-100 hover:bg-stone-200 text-[#2d3a27] font-mono text-xs rounded-xl font-bold cursor-pointer transition-all flex items-center justify-center gap-1.5 border border-[#e2e2d8] active:scale-95"
                      title="Sposta in basso nella serra"
                    >
                      <ArrowDown className="w-3.5 h-3.5 text-sage-600 animate-bounce" /> Sposta Giù
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    const plant = longPressedPlant;
                    setLongPressedPlant(null);
                    setPlantIdToDelete(plant.id);
                  }}
                  className="w-full py-2.5 bg-red-600 hover:bg-red-700 text-white font-mono text-xs rounded-xl font-bold cursor-pointer transition-all flex items-center justify-center gap-2 shadow-xs"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Elimina Pianta
                </button>
              </div>

              <button
                type="button"
                onClick={() => setLongPressedPlant(null)}
                className="w-full py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 font-mono text-xs rounded-xl transition-all cursor-pointer font-bold text-center"
              >
                Annulla
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- TOAST NOTIFICA SYSTEM --- */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: 15, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            className="fixed bottom-6 right-6 bg-[#2d3a2e] text-[#f4f6f3] border border-sage-500/30 p-4 rounded-2xl shadow-xl z-50 max-w-sm text-xs font-mono flex items-center gap-3"
          >
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></div>
            <span>{toastMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* --- MODALE 11: LIGHTBOX ANTEPRIMA IMMAGINI SCHERMO INTERO --- */}
      <AnimatePresence>
        {fullscreenImageUrl && (
          <div className="fixed inset-0 bg-black/90 backdrop-blur-md flex items-center justify-center p-4 z-[100] select-none">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative max-w-5xl w-full max-h-[90vh] flex flex-col items-center justify-center"
            >
              {/* Bottone Chiudi in alto a destra */}
              <button
                type="button"
                onClick={() => setFullscreenImageUrl(null)}
                className="absolute -top-12 right-0 md:-right-4 p-2 bg-white/15 hover:bg-white/25 active:scale-95 rounded-full text-white cursor-pointer transition-all border border-white/20 flex items-center justify-center"
                title="Chiudi visualizzazione"
              >
                <X className="w-5 h-5" />
              </button>

              {/* L'immagine stessa */}
              <img
                src={fullscreenImageUrl}
                alt="Ingrandimento botanico"
                className="max-w-full max-h-[85vh] object-contain rounded-2xl select-none shadow-2xl border border-white/10"
                referrerPolicy="no-referrer"
              />
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
