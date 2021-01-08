import { typeOf } from '@ember/utils';
import isObject from './is-object';
function isPromiseLike(obj) {
    return !!obj
        && !!obj.then
        && !!obj.catch
        && !!obj.finally
        && typeOf(obj.then) === 'function'
        && typeOf(obj.catch) === 'function'
        && typeOf(obj.finally) === 'function';
}
export default function isPromise(obj) {
    return isObject(obj) && isPromiseLike(obj);
}
