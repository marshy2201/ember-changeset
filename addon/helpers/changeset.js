import { helper } from '@ember/component/helper';
import Changeset from 'ember-changeset';
import isChangeset from 'ember-changeset/utils/is-changeset';
import isPromise from 'ember-changeset/utils/is-promise';
export function changeset([obj, validations], options = {}) {
    if (isChangeset(obj)) {
        return obj;
    }
    if (isPromise(obj)) {
        return Promise.resolve(obj).then((resolved) => new Changeset(resolved, validations, {}, options));
    }
    return new Changeset(obj, validations, {}, options);
}
export default helper(changeset);
