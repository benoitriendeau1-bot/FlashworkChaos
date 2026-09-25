export function errorAdvice(error) {
  const code = error?.code || '';
  const status = error?.status || 0;
  if (!error || error.name === 'AbortError') return null;
  if (status === 0 || code === 'unavailable') {
    return { title: 'Serveur indisponible', action: 'Démarrez le dashboard, puis réessayez.' };
  }
  if (code === 'coverage_missing') {
    return { title: 'Couverture absente', action: 'Le serveur ne reconstruit rien. La commande coverage se lance à part, si vous la voulez.' };
  }
  if (code === 'coverage_writing') {
    return { title: 'Couverture en cours d’écriture', action: 'Attendez la fin de l’écriture, puis réessayez.' };
  }
  if (code === 'coverage_unsupported' || code === 'coverage_invalid') {
    return { title: 'Couverture inutilisable', action: 'Ce fichier n’est pas une couverture valide. Il n’est pas affiché comme un PASS.' };
  }
  if (code === 'ambiguous_action') {
    return { title: 'Action ambiguë', action: 'Choisissez une correspondance. La première n’est pas prise automatiquement.' };
  }
  if (code === 'event_not_found' || code === 'event_not_scanned' || code === 'events_missing') {
    return { title: 'Événement absent', action: 'Cette séquence n’a pas été lue. Le journal complet n’est pas chargé.' };
  }
  if (status === 413 || code === 'page_too_large' || code === 'event_too_large') {
    return { title: 'Demande trop grande', action: 'Réduisez la page ou le niveau de détail.' };
  }
  if (code === 'run_not_found') {
    return { title: 'Run introuvable', action: 'Retournez à la liste. Le dossier a pu disparaître.' };
  }
  return { title: 'Erreur API', action: 'Réessayez. Aucun verdict n’a été inventé.' };
}
