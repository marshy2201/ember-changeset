import { computed, get } from '@ember/object';
const { keys } = Object;
/**
 * Transform an Object's values with a `transform` function.
 */
export default function transform(dependentKey, transform) {
    return computed(dependentKey, function () {
        let obj = get(this, dependentKey);
        return keys(obj).reduce((newObj, key) => {
            newObj[key] = transform(obj[key]);
            return newObj;
        }, {});
    });
}
