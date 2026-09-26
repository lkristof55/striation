// The bundled reference set (data/reference.json), built by `npm run build:ref` from data/corpus.json.gz.
import reference from '../data/reference.json' with { type: 'json' };

export function loadReference() {
  return reference;
}
