import Helper from '@ember/component/helper';
import { observer } from '@ember/object';
const CONTENT = '_content';
const CHANGES = '_changes';
export default class ChangesetGet extends Helper.extend({
    invalidate: observer(`changeset.${CONTENT}`, `changeset.${CHANGES}`, function () {
        this.recompute();
    })
}) {
    constructor() {
        super(...arguments);
        this.changeset = null;
    }
    compute([changeset, fieldPath]) {
        if (this.changeset === null) {
            this.set('changeset', changeset);
        }
        if (!this.changeset) {
            return;
        }
        return this.changeset.get(fieldPath);
    }
}
