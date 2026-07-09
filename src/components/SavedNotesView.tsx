import React, { useState, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowLeft,
  Plus,
  Trash2,
  Edit,
  Upload,
  X,
  FileText,
  Image as ImageIcon,
  ChevronLeft,
  BookOpen,
  ArrowUp,
  ArrowDown,
  Copy,
  Check
} from "lucide-react";
import { Plant, SavedNote } from "../types";

// Helper to convert ISO date to YYYY-MM-DDTHH:MM local datetime format
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

// Light-weight image compression helpers inside the component to prevent bloat
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

interface SavedNotesViewProps {
  plant: Plant;
  allPlants: Plant[];
  onBack: () => void;
  onUpdateNotes: (plantId: string, notes: SavedNote[]) => void;
  isReadOnlyMode: boolean;
  showToast: (msg: string) => void;
}

export const SavedNotesView: React.FC<SavedNotesViewProps> = ({
  plant,
  allPlants,
  onBack,
  onUpdateNotes,
  isReadOnlyMode,
  showToast,
}) => {
  const notes = plant.savedNotes || [];

  // Navigation states
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<SavedNote | null>(null);
  const [noteIdToDelete, setNoteIdToDelete] = useState<string | null>(null);

  // Form states
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [coverImage, setCoverImage] = useState("");
  const [additionalImages, setAdditionalImages] = useState<string[]>([]);
  const [inputUrl, setInputUrl] = useState("");
  const [inputAdditionalUrl, setInputAdditionalUrl] = useState("");
  const [createdAt, setCreatedAt] = useState("");

  // Refs for file inputs
  const coverInputRef = useRef<HTMLInputElement>(null);
  const extraInputRef = useRef<HTMLInputElement>(null);

  // Zoomed-in image state
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);

  // Copy states
  const [noteToCopy, setNoteToCopy] = useState<SavedNote | null>(null);
  const [selectedTargetPlantIds, setSelectedTargetPlantIds] = useState<string[]>([]);

  // Handlers for Form
  const openNewNoteForm = () => {
    setEditingNote(null);
    setTitle("");
    setDescription("");
    setCoverImage("");
    setAdditionalImages([]);
    setInputUrl("");
    setInputAdditionalUrl("");
    setCreatedAt(toLocalDatetimeString(new Date().toISOString()));
    setIsFormOpen(true);
  };

  const openEditNoteForm = (note: SavedNote) => {
    setEditingNote(note);
    setTitle(note.title);
    setDescription(note.description);
    setCoverImage(note.coverImage || "");
    setAdditionalImages(note.images || []);
    setInputUrl("");
    setInputAdditionalUrl("");
    setCreatedAt(toLocalDatetimeString(note.createdAt));
    setIsFormOpen(true);
  };

  const handleCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files[0]) {
      showToast("Compressione copertina... 🖼️⚡");
      try {
        const compressed = await compressFile(files[0], 500, 0.5);
        setCoverImage(compressed);
        showToast("Copertina aggiunta correttamente!");
      } catch (_) {
        showToast("Errore durante il caricamento.");
      }
    }
  };

  const handleExtraUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files[0]) {
      showToast("Compressione immagine aggiuntiva... 🖼️⚡");
      try {
        const compressed = await compressFile(files[0], 500, 0.5);
        setAdditionalImages(prev => [...prev, compressed]);
        showToast("Immagine galleria aggiunta!");
      } catch (_) {
        showToast("Errore durante il caricamento.");
      }
    }
  };

  const handleAddCoverUrl = () => {
    if (inputUrl.trim()) {
      setCoverImage(inputUrl.trim());
      setInputUrl("");
      showToast("URL copertina impostato!");
    }
  };

  const handleAddExtraUrl = () => {
    if (inputAdditionalUrl.trim()) {
      setAdditionalImages(prev => [...prev, inputAdditionalUrl.trim()]);
      setInputAdditionalUrl("");
      showToast("URL galleria aggiunto!");
    }
  };

  const handleRemoveExtraImage = (index: number) => {
    setAdditionalImages(prev => prev.filter((_, i) => i !== index));
    showToast("Immagine rimossa dalla galleria.");
  };

  const handleSaveNote = (e: React.FormEvent) => {
    e.preventDefault();
    const finalTitle = title.trim();
    const finalDescription = description.trim();

    const isoCreatedAt = createdAt ? new Date(createdAt).toISOString() : new Date().toISOString();

    if (editingNote) {
      // Modifica nota esistente
      const updatedNotes = notes.map(n => {
        if (n.id === editingNote.id) {
          return {
            ...n,
            title: finalTitle,
            description: finalDescription,
            coverImage: coverImage.trim() || undefined,
            images: additionalImages,
            createdAt: isoCreatedAt,
          };
        }
        return n;
      });
      onUpdateNotes(plant.id, updatedNotes);
      showToast("Nota modificata correttamente! 📝");
    } else {
      // Crea nuova nota
      const newNote: SavedNote = {
        id: "note-" + Date.now(),
        title: finalTitle,
        description: finalDescription,
        coverImage: coverImage.trim() || undefined,
        images: additionalImages,
        createdAt: isoCreatedAt,
      };
      onUpdateNotes(plant.id, [newNote, ...notes]);
      showToast("Nuova nota salvata con successo! 📝🌿");
    }

    setIsFormOpen(false);
  };

  const handleDeleteNote = (noteId: string) => {
    setNoteIdToDelete(noteId);
  };

  const confirmDeleteNote = () => {
    if (!noteIdToDelete) return;
    const updatedNotes = notes.filter(n => n.id !== noteIdToDelete);
    onUpdateNotes(plant.id, updatedNotes);
    if (activeNoteId === noteIdToDelete) {
      setActiveNoteId(null);
    }
    setNoteIdToDelete(null);
    showToast("Nota eliminata permanentemente. 🗑️");
  };

  const handleConfirmCopy = () => {
    if (!noteToCopy) return;
    if (selectedTargetPlantIds.length === 0) {
      showToast("Seleziona almeno una pianta a cui copiare la nota! 🌿");
      return;
    }

    selectedTargetPlantIds.forEach(targetId => {
      const targetPlant = allPlants.find(p => p.id === targetId);
      if (targetPlant) {
        const clonedNote: SavedNote = {
          ...noteToCopy,
          id: "note-copied-" + Date.now() + "-" + Math.random().toString(36).substr(2, 5),
          createdAt: new Date().toISOString()
        };
        const existingNotes = targetPlant.savedNotes || [];
        onUpdateNotes(targetId, [clonedNote, ...existingNotes]);
      }
    });

    showToast(`Nota "${noteToCopy.title}" copiata correttamente su ${selectedTargetPlantIds.length} piant${selectedTargetPlantIds.length === 1 ? 'a' : 'e'}! 📋🌿`);
    setNoteToCopy(null);
    setSelectedTargetPlantIds([]);
  };

  const toggleSelectTargetPlant = (plantId: string) => {
    setSelectedTargetPlantIds(prev =>
      prev.includes(plantId) ? prev.filter(id => id !== plantId) : [...prev, plantId]
    );
  };

  const moveNote = (noteId: string, direction: "up" | "down") => {
    if (isReadOnlyMode) return;
    const noteIndex = notes.findIndex(n => n.id === noteId);
    if (noteIndex === -1) return;

    const swapIndex = direction === "up" ? noteIndex - 1 : noteIndex + 1;
    if (swapIndex < 0 || swapIndex >= notes.length) {
      showToast(direction === "up" ? "La nota è già in cima! 📝" : "La nota è già in fondo! 📝");
      return;
    }

    const updatedNotes = [...notes];
    const temp = updatedNotes[noteIndex];
    updatedNotes[noteIndex] = updatedNotes[swapIndex];
    updatedNotes[swapIndex] = temp;

    onUpdateNotes(plant.id, updatedNotes);
    showToast(direction === "up" ? "Nota spostata in alto ⬆️" : "Nota spostata in basso ⬇️");
  };

  const activeNote = notes.find(n => n.id === activeNoteId);

  return (
    <div className="space-y-6 font-sans">
      {/* HEADER PRINCIPALE */}
      <div className="flex items-center justify-between border-b border-[#e2e2d8] pb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 hover:bg-sage-100 rounded-full text-sage-700 transition-colors cursor-pointer"
            title="Torna ai dettagli e doveri della pianta"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="text-xl font-serif font-black text-[#2d3a27]">Note Salvate</h2>
            <p className="text-[10px] text-sage-400 font-mono uppercase tracking-wider">
              {plant.nickname}
            </p>
          </div>
        </div>

        {!isReadOnlyMode && !isFormOpen && !activeNoteId && (
          <button
            onClick={openNewNoteForm}
            className="flex items-center gap-1 text-xs font-mono uppercase font-semibold text-white bg-emerald-700 hover:bg-emerald-850 transition-all rounded-full px-4 py-2 shadow-sm cursor-pointer"
          >
            <Plus className="w-4 h-4" /> Nuova Nota
          </button>
        )}
      </div>

      {/* DETTAGLIO SINGOLA NOTA COMPLETA */}
      {activeNoteId && activeNote ? (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-3xl border border-[#e2e2d8] p-6 space-y-5 shadow-sm"
        >
          {/* Sotto-Header Dettaglio */}
          <div className="flex items-center justify-between border-b border-[#f5f5f0] pb-3">
            <button
              onClick={() => setActiveNoteId(null)}
              className="flex items-center gap-1.5 text-xs text-sage-500 hover:text-sage-800 font-semibold cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" /> Torna alla lista note
            </button>

            {!isReadOnlyMode && (
              <div className="flex gap-2">
                <button
                  onClick={() => openEditNoteForm(activeNote)}
                  className="p-1.5 px-3 bg-[#f5f5f0] border border-[#e2e2d8] hover:bg-white rounded-lg text-sage-700 text-[10px] font-semibold transition-all flex items-center gap-1 cursor-pointer"
                >
                  <Edit className="w-3.5 h-3.5" /> Modifica
                </button>
                <button
                  onClick={() => handleDeleteNote(activeNote.id)}
                  className="p-1.5 px-3 bg-red-50 hover:bg-red-100 rounded-lg text-red-600 text-[10px] font-semibold transition-all flex items-center gap-1 cursor-pointer border border-red-200"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Elimina
                </button>
              </div>
            )}
          </div>

          <div className="space-y-4">
            <span className="text-[10px] text-sage-400 font-mono block">
              Registrata il {new Date(activeNote.createdAt).toLocaleString("it-IT", {
                day: "2-digit",
                month: "long",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit"
              })}
            </span>

            <h3 className="text-2xl font-serif italic text-[#2d3a27] font-bold">
              {activeNote.title || <span className="italic text-stone-400">Senza Titolo</span>}
            </h3>

            {/* Immagine di Copertina */}
            {activeNote.coverImage && (
              <div 
                className="rounded-2xl overflow-hidden max-h-80 w-full cursor-zoom-in border border-[#e2e2d8]"
                onClick={() => setZoomedImage(activeNote.coverImage || null)}
                title="Clicca per ingrandire"
              >
                <img 
                  src={activeNote.coverImage} 
                  alt={activeNote.title} 
                  className="w-full h-full object-cover max-h-80 hover:scale-[1.01] transition-transform duration-500" 
                />
              </div>
            )}

            {/* Descrizione Completa */}
            <div className="text-sm text-sage-750 leading-relaxed whitespace-pre-wrap font-sans bg-[#fbfbf9] p-5 rounded-2xl border border-stone-50">
              {activeNote.description || <p className="italic text-sage-400">Nessuna descrizione o dettaglio inserito.</p>}
            </div>

            {/* Galleria Immagini Aggiuntive */}
            {activeNote.images && activeNote.images.length > 0 && (
              <div className="space-y-2 pt-4 border-t border-stone-150">
                <h4 className="text-[11px] font-mono uppercase tracking-wider text-sage-500 flex items-center gap-1">
                  <ImageIcon className="w-3.5 h-3.5" /> Altre Immagini della Galleria
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {activeNote.images.map((imgUrl, i) => (
                    <div 
                      key={i} 
                      className="aspect-square rounded-xl overflow-hidden cursor-zoom-in border border-[#e2e2d8] relative group"
                      onClick={() => setZoomedImage(imgUrl)}
                      title="Clicca per zoomare"
                    >
                      <img src={imgUrl} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                      <div className="absolute inset-0 bg-black/10 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <span className="text-[9px] bg-black/60 text-white p-1 px-2 rounded font-mono">ZOOM</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </motion.div>
      ) : isFormOpen ? (
        /* FORM CREAZIONE / MODIFICA */
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-3xl border border-[#e2e2d8] p-6 space-y-5 shadow-sm"
        >
          <div className="flex items-center justify-between border-b border-[#f5f5f0] pb-3">
            <h3 className="font-serif italic text-sage-900 font-bold text-base">
              {editingNote ? "Modifica Nota Salvata" : "Nuova Nota Salvata"}
            </h3>
            <button
              onClick={() => setIsFormOpen(false)}
              className="p-1 hover:bg-stone-100 rounded-lg text-stone-500 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <form onSubmit={handleSaveNote} className="space-y-4">
            <div className="flex flex-col gap-1">
              <label className="font-mono text-[10px] text-sage-400 uppercase">Titolo Nota</label>
              <input
                type="text"
                placeholder="es. Istruzioni per Concime o Bisogni di Luce (Opzionale)"
                value={title}
                onChange={e => setTitle(e.target.value)}
                className="p-2.5 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400 text-xs"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="font-mono text-[10px] text-sage-400 uppercase">Data di Creazione / Registrazione</label>
              <input
                type="datetime-local"
                value={createdAt}
                onChange={e => setCreatedAt(e.target.value)}
                className="p-2.5 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400 text-xs font-mono"
                required
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="font-mono text-[10px] text-sage-400 uppercase">Dettagli / Descrizione Nota</label>
              <textarea
                placeholder="Scrivi qui tutte le informazioni dettagliate della pianta, bisogni idrici completi, terreno, propagazione..."
                value={description}
                onChange={e => setDescription(e.target.value)}
                rows={6}
                className="p-2.5 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400 text-xs resize-y"
              />
            </div>

            {/* IMMAGINE COPERTINA */}
            <div className="space-y-1">
              <label className="font-mono text-[10px] text-sage-400 uppercase block">Immagine di Copertina (File dispositivo o URL)</label>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
                <div
                  onClick={() => coverInputRef.current?.click()}
                  className="border-2 border-dashed border-sage-300 hover:border-emerald-400 rounded-xl p-4 text-center cursor-pointer transition-colors flex flex-col items-center justify-center gap-1 bg-[#fbfbf9]"
                >
                  <Upload className="w-4 h-4 text-sage-400" />
                  <span className="text-[10px] text-sage-600 font-medium">Carica dal dispositivo</span>
                  <input
                    type="file"
                    ref={coverInputRef}
                    className="hidden"
                    accept="image/*"
                    onChange={handleCoverUpload}
                  />
                </div>

                <div className="space-y-1">
                  <span className="text-[9px] font-mono text-sage-400 uppercase">Oppure inserisci URL internet</span>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="https://images.unsplash.com/..."
                      value={inputUrl}
                      onChange={e => setInputUrl(e.target.value)}
                      className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400 text-xs flex-1 font-mono"
                    />
                    <button
                      type="button"
                      onClick={handleAddCoverUrl}
                      className="px-3 bg-sage-800 hover:bg-sage-900 text-white rounded-xl text-[10px] font-mono font-semibold transition-all cursor-pointer"
                    >
                      OK
                    </button>
                  </div>
                </div>
              </div>

              {coverImage && (
                <div className="flex items-center gap-2 mt-2 p-2 bg-sage-50 rounded-xl border border-stone-150">
                  <img src={coverImage} className="w-12 h-12 object-cover rounded-lg border" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[9px] text-sage-400 font-mono">Copertina Attuale</p>
                    <p className="text-[9px] text-sage-600 truncate max-w-xs">{coverImage}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setCoverImage("");
                      showToast("Copertina rimossa.");
                    }}
                    className="p-1 hover:bg-red-50 text-red-500 rounded-full transition-colors cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* GALLERIA ALTRE IMMAGINI */}
            <div className="space-y-1 pt-3 border-t border-stone-100">
              <label className="font-mono text-[10px] text-sage-400 uppercase block">Galleria Altre Immagini (Aggiungi più foto)</label>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
                <div
                  onClick={() => extraInputRef.current?.click()}
                  className="border-2 border-dashed border-sage-300 hover:border-emerald-400 rounded-xl p-4 text-center cursor-pointer transition-colors flex flex-col items-center justify-center gap-1 bg-[#fbfbf9]"
                >
                  <Upload className="w-4 h-4 text-sage-400" />
                  <span className="text-[10px] text-sage-600 font-medium">Aggiungi foto dispositivo</span>
                  <input
                    type="file"
                    ref={extraInputRef}
                    className="hidden"
                    accept="image/*"
                    onChange={handleExtraUpload}
                  />
                </div>

                <div className="space-y-1">
                  <span className="text-[9px] font-mono text-sage-400 uppercase">Oppure aggiungi via URL</span>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="https://images.unsplash.com/..."
                      value={inputAdditionalUrl}
                      onChange={e => setInputAdditionalUrl(e.target.value)}
                      className="p-2 border border-[#e4e8e1] rounded-xl focus:outline-none focus:border-sage-400 text-xs flex-1 font-mono"
                    />
                    <button
                      type="button"
                      onClick={handleAddExtraUrl}
                      className="px-3 bg-sage-800 hover:bg-sage-900 text-white rounded-xl text-[10px] font-mono font-semibold transition-all cursor-pointer"
                    >
                      Aggiungi
                    </button>
                  </div>
                </div>
              </div>

              {additionalImages.length > 0 && (
                <div className="space-y-1.5 mt-2">
                  <p className="text-[9px] text-sage-400 font-mono">Galleria Note Attuale ({additionalImages.length} foto)</p>
                  <div className="grid grid-cols-4 sm:grid-cols-6 gap-2 p-2 bg-stone-50 rounded-xl border border-stone-150">
                    {additionalImages.map((img, idx) => (
                      <div key={idx} className="relative aspect-square border rounded-lg overflow-hidden group">
                        <img src={img} className="w-full h-full object-cover" />
                        <button
                          type="button"
                          onClick={() => handleRemoveExtraImage(idx)}
                          className="absolute top-1 right-1 bg-red-600 hover:bg-red-700 text-white p-0.5 rounded-full shadow-md transition-colors cursor-pointer"
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-3">
              <button
                type="submit"
                className="flex-1 py-3 bg-emerald-700 hover:bg-emerald-850 text-white font-serif font-black tracking-tight text-center rounded-2xl cursor-pointer shadow-md transition-all text-xs"
              >
                Salva Nota
              </button>
              <button
                type="button"
                onClick={() => setIsFormOpen(false)}
                className="px-6 py-3 bg-stone-100 hover:bg-stone-200 text-stone-700 font-serif font-bold text-center rounded-2xl cursor-pointer transition-all text-xs"
              >
                Annulla
              </button>
            </div>
          </form>
        </motion.div>
      ) : (
        /* LISTA DI TUTTE LE NOTE */
        <div className="space-y-4">
          {notes.length === 0 ? (
            <div className="text-center p-10 bg-[#fbfbf9] rounded-3xl border border-dashed border-sage-300 space-y-3">
              <BookOpen className="w-8 h-8 text-[#7e8c69] mx-auto opacity-70" />
              <div className="space-y-1 max-w-md mx-auto">
                <h4 className="font-serif italic font-bold text-sage-800 text-sm">Nessuna nota salvata</h4>
                <p className="text-[11px] text-sage-400 leading-relaxed">
                  Aggiungi appunti, dettagli di concimazione, bisogni specifici di acqua, esposizione, propagazione o segreti della tua pianta. Rimarrà tutto salvato in questo archivio!
                </p>
              </div>
              {!isReadOnlyMode && (
                <button
                  onClick={openNewNoteForm}
                  className="mt-2 inline-flex items-center gap-1 text-[11px] font-mono uppercase font-semibold text-white bg-emerald-700 hover:bg-emerald-850 transition-all rounded-full px-4 py-2 cursor-pointer shadow-xs"
                >
                  <Plus className="w-3.5 h-3.5" /> Crea la prima nota
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {notes.map(note => {
                const cleanDesc = note.description || "";
                const previewText = cleanDesc.length > 85 ? cleanDesc.substring(0, 85) + "..." : cleanDesc;

                return (
                  <motion.div
                    key={note.id}
                    onClick={() => setActiveNoteId(note.id)}
                    whileHover={{ scale: 1.01 }}
                    className="bg-white rounded-2xl border border-[#e2e2d8] hover:border-emerald-400 overflow-hidden cursor-pointer transition-all shadow-xs flex flex-col justify-between"
                  >
                    <div>
                      {/* Copertina card */}
                      {note.coverImage ? (
                        <div className="h-32 w-full overflow-hidden border-b border-stone-100">
                          <img src={note.coverImage} className="w-full h-full object-cover" />
                        </div>
                      ) : (
                        <div className="h-10 w-full bg-gradient-to-r from-sage-50 to-stone-50 border-b border-stone-100/50" />
                      )}

                      <div className="p-4 space-y-1.5">
                        <span className="text-[8px] font-mono text-sage-400 block">
                          {new Date(note.createdAt).toLocaleDateString("it-IT")}
                        </span>
                        <h4 className="font-serif font-black text-[#2d3a27] text-sm truncate leading-tight">
                          {note.title || <span className="italic text-stone-400">Senza Titolo</span>}
                        </h4>
                        <p className="text-[11px] text-sage-500 leading-relaxed line-clamp-3">
                          {previewText || <span className="italic text-sage-300">Nessuna descrizione.</span>}
                        </p>
                      </div>
                    </div>

                    <div className="p-3 bg-stone-50/50 border-t border-[#f5f5f0] flex items-center justify-between text-[10px] font-mono text-sage-400">
                      <span className="text-[8.5px] italic text-sage-400">
                        {note.images && note.images.length > 0 ? `+${note.images.length} foto in galleria` : "Nessuna foto extra"}
                      </span>

                      {!isReadOnlyMode && (
                        <div className="flex gap-1.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              moveNote(note.id, "up");
                            }}
                            className="p-1 hover:bg-[#faf6f0] rounded text-sage-600 transition-colors cursor-pointer"
                            title="Sposta nota sopra"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              moveNote(note.id, "down");
                            }}
                            className="p-1 hover:bg-[#faf6f0] rounded text-sage-600 transition-colors cursor-pointer"
                            title="Sposta nota sotto"
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditNoteForm(note);
                            }}
                            className="p-1 hover:bg-sage-100 rounded text-sage-600 transition-colors cursor-pointer"
                            title="Modifica nota"
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setNoteToCopy(note);
                              setSelectedTargetPlantIds([]);
                            }}
                            className="p-1 hover:bg-emerald-50 rounded text-emerald-600 transition-colors cursor-pointer"
                            title="Copia questa nota su altre piante"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteNote(note.id);
                            }}
                            className="p-1 hover:bg-red-50 rounded text-red-500 transition-colors cursor-pointer"
                            title="Elimina nota"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* MODALE FULLSCREEN DI ZOOM IMMAGINE */}
      <AnimatePresence>
        {zoomedImage && (
          <div 
            className="fixed inset-0 bg-black/90 flex items-center justify-center p-4 z-[100] cursor-zoom-out animate-fade-in"
            onClick={() => setZoomedImage(null)}
          >
            <button 
              className="absolute top-4 right-4 bg-white/10 hover:bg-white/20 text-white p-2.5 rounded-full cursor-pointer transition-colors"
              onClick={() => setZoomedImage(null)}
            >
              <X className="w-6 h-6" />
            </button>
            <motion.img 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              src={zoomedImage} 
              alt="Zoomed" 
              className="max-w-full max-h-[85vh] object-contain rounded-2xl shadow-2xl" 
            />
          </div>
        )}
      </AnimatePresence>

      {/* MODALE DI CONFERMA ELIMINAZIONE NOTA CUSTOM */}
      <AnimatePresence>
        {noteIdToDelete && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 z-[110]">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white rounded-3xl border border-[#e2e2d8] p-6 max-w-sm w-full space-y-4 shadow-xl text-center"
            >
              <div className="w-12 h-12 bg-red-50 text-red-600 rounded-full flex items-center justify-center mx-auto">
                <Trash2 className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h4 className="font-serif font-black text-stone-900 text-base">Elimina Nota</h4>
                <p className="text-xs text-sage-500 leading-relaxed">
                  Sei sicuro di voler eliminare definitivamente questa nota salvata? L'azione non può essere annullata.
                </p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={confirmDeleteNote}
                  className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-semibold cursor-pointer transition-all active:scale-98"
                >
                  Sì, elimina
                </button>
                <button
                  onClick={() => setNoteIdToDelete(null)}
                  className="flex-1 py-2.5 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-xl text-xs font-semibold cursor-pointer transition-all active:scale-98"
                >
                  Annulla
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* MODALE DI SELEZIONE PIANTE PER COPIA NOTA */}
      <AnimatePresence>
        {noteToCopy && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 z-[110]">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white rounded-3xl border border-[#e2e2d8] p-6 max-w-md w-full space-y-4 shadow-xl flex flex-col max-h-[85vh] font-sans text-xs"
            >
              <div className="flex items-center justify-between pb-3 border-b border-stone-100">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-emerald-50 text-emerald-600 rounded-xl">
                    <Copy className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="font-serif font-black text-stone-900 text-sm">Copia Nota</h4>
                    <p className="text-[10px] font-mono uppercase text-sage-400">Duplica su altre specie</p>
                  </div>
                </div>
                <button
                  onClick={() => setNoteToCopy(null)}
                  className="p-1 hover:bg-stone-100 rounded-lg text-stone-400 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-1">
                <p className="text-xs text-sage-600">
                  Stai copiando la nota: <strong className="text-stone-800 font-bold">"{noteToCopy.title}"</strong>
                </p>
                <p className="text-[10px] text-sage-400">
                  Seleziona una o più piante target per duplicare questa nota nella loro scheda:
                </p>
              </div>

              {/* Lista Piante */}
              <div className="flex-1 overflow-y-auto pr-1 py-1 space-y-2 max-h-[40vh]">
                {allPlants.filter(p => p.id !== plant.id).length === 0 ? (
                  <p className="text-center py-6 text-xs italic text-sage-400">
                    Non ci sono altre piante nell'erbario a cui copiare questa nota.
                  </p>
                ) : (
                  allPlants
                    .filter(p => p.id !== plant.id)
                    .map(p => {
                      const isSelected = selectedTargetPlantIds.includes(p.id);
                      return (
                        <div
                          key={p.id}
                          onClick={() => toggleSelectTargetPlant(p.id)}
                          className={`flex items-center justify-between p-2.5 rounded-xl border transition-all cursor-pointer ${
                            isSelected
                              ? "bg-emerald-50/50 border-emerald-400 shadow-2xs"
                              : "bg-stone-50/30 border-stone-100 hover:bg-stone-50 hover:border-stone-200"
                          }`}
                        >
                          <div className="flex items-center gap-3 font-sans">
                            {p.imageUrl ? (
                              <img
                                src={p.imageUrl}
                                alt={p.name}
                                className="w-9 h-9 object-cover rounded-lg border border-stone-200"
                              />
                            ) : (
                              <div className="w-9 h-9 bg-stone-100 rounded-lg flex items-center justify-center text-xs">
                                🌱
                              </div>
                            )}
                            <div>
                              <div className="font-serif font-bold text-[#2d3a27] text-xs leading-none">
                                {p.name || p.species}
                              </div>
                              <div className="text-[9px] font-mono text-sage-400 mt-1">
                                {p.nickname ? `"${p.nickname}"` : p.species}
                              </div>
                            </div>
                          </div>

                          <div
                            className={`w-4 h-4 rounded-md border flex items-center justify-center transition-all ${
                              isSelected
                                ? "bg-emerald-600 border-emerald-600 text-white"
                                : "border-stone-300 bg-white"
                            }`}
                          >
                            {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                          </div>
                        </div>
                      );
                    })
                )}
              </div>

              <div className="flex gap-3 pt-3 border-t border-stone-100 font-mono text-xs">
                <button
                  onClick={handleConfirmCopy}
                  disabled={selectedTargetPlantIds.length === 0}
                  className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-stone-100 disabled:text-stone-400 text-white rounded-xl text-xs font-semibold cursor-pointer transition-all active:scale-98 flex items-center justify-center gap-1"
                >
                  <Copy className="w-3.5 h-3.5" />
                  Conferma copia ({selectedTargetPlantIds.length})
                </button>
                <button
                  onClick={() => setNoteToCopy(null)}
                  className="flex-1 py-2.5 bg-[#fcfcf9] hover:bg-[#fafaf3] border border-[#e2e2d8] text-sage-700 rounded-xl text-xs font-semibold cursor-pointer transition-all active:scale-98"
                >
                  Annulla
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
