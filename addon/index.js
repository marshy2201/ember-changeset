import { A as emberArray, isArray, } from '@ember/array';
import { assert } from '@ember/debug';
import EmberObject, { get, set, } from '@ember/object';
import { not, readOnly, } from '@ember/object/computed';
import Evented from '@ember/object/evented';
import { isEmpty, isEqual, isNone, isPresent, } from '@ember/utils';
import Change from 'ember-changeset/-private/change';
import Err from 'ember-changeset/-private/err';
import pureAssign from 'ember-changeset/utils/assign';
import inflate from 'ember-changeset/utils/computed/inflate';
import isEmptyObject from 'ember-changeset/utils/computed/is-empty-object';
import objectToArray from 'ember-changeset/utils/computed/object-to-array';
import transform from 'ember-changeset/utils/computed/transform';
import includes from 'ember-changeset/utils/includes';
import isChangeset, { CHANGESET } from 'ember-changeset/utils/is-changeset';
import isObject from 'ember-changeset/utils/is-object';
import isPromise from 'ember-changeset/utils/is-promise';
import mergeNested from 'ember-changeset/utils/merge-nested';
import objectWithout from 'ember-changeset/utils/object-without';
import setNestedProperty from 'ember-changeset/utils/set-nested-property';
import take from 'ember-changeset/utils/take';
import validateNestedObj from 'ember-changeset/utils/validate-nested-obj';
import deepSet from 'ember-deep-set';
import { all, resolve, } from 'rsvp';
const { keys } = Object;
const CONTENT = '_content';
const CHANGES = '_changes';
const ERRORS = '_errors';
const VALIDATOR = '_validator';
const OPTIONS = '_options';
const RUNNING_VALIDATIONS = '_runningValidations';
const BEFORE_VALIDATION_EVENT = 'beforeValidation';
const AFTER_VALIDATION_EVENT = 'afterValidation';
const AFTER_ROLLBACK_EVENT = 'afterRollback';
const defaultValidatorFn = () => true;
const defaultOptions = { skipValidate: false };
/**
 * Creates new changesets.
 *
 * @uses Ember.Evented
 */
export function changeset(obj, validateFn = defaultValidatorFn, validationMap = {}, options = {}) {
    assert('Underlying object for changeset is missing', isPresent(obj));
    let changeset = {
        // notifyPropertyChange: (s: string) => void,
        // trigger: (k: string, v: string | void) => void,
        __changeset__: CHANGESET,
        _content: {},
        _changes: {},
        _errors: {},
        _validator: defaultValidatorFn,
        _options: defaultOptions,
        _runningValidations: {},
        _bareChanges: transform(CHANGES, (c) => c.value),
        changes: objectToArray(CHANGES, (c) => c.value, false),
        errors: objectToArray(ERRORS, (e) => ({ value: e.value, validation: e.validation }), true),
        change: inflate(CHANGES, (c) => c.value),
        error: inflate(ERRORS, (e) => ({ value: e.value, validation: e.validation })),
        data: readOnly(CONTENT),
        isValid: isEmptyObject(ERRORS),
        isPristine: isEmptyObject(CHANGES),
        isInvalid: not('isValid').readOnly(),
        isDirty: not('isPristine').readOnly(),
        init() {
            let c = this;
            c._super(...arguments);
            c[CONTENT] = obj;
            c[CHANGES] = {};
            c[ERRORS] = {};
            c[VALIDATOR] = validateFn;
            c[OPTIONS] = pureAssign(defaultOptions, options);
            c[RUNNING_VALIDATIONS] = {};
        },
        /**
         * Proxies `get` to the underlying content or changed value, if present.
         */
        unknownProperty(key) {
            return this._valueFor(key);
        },
        /**
         * Stores change on the changeset.
         *
         * @method setUnknownProperty
         */
        setUnknownProperty(key, value) {
            let config = get(this, OPTIONS);
            let skipValidate = get(config, 'skipValidate');
            if (skipValidate) {
                let content = get(this, CONTENT);
                let oldValue = get(content, key);
                this._setProperty({ key, value, oldValue });
                return this._handleValidation(true, { key, value });
            }
            let content = get(this, CONTENT);
            let oldValue = get(content, key);
            this._setProperty({ key, value, oldValue });
            return this._validateKey(key, value);
        },
        /**
         * String representation for the changeset.
         */
        toString() {
            let normalisedContent = pureAssign(get(this, CONTENT), {});
            return `changeset:${normalisedContent.toString()}`;
        },
        /**
         * Provides a function to run before emitting changes to the model. The
         * callback function must return a hash in the same shape:
         *
         * ```
         * changeset
         *   .prepare((changes) => {
         *     let modified = {};
         *
         *     for (let key in changes) {
         *       modified[underscore(key)] = changes[key];
         *     }
         *
         *    return modified; // { first_name: "Jim", last_name: "Bob" }
         *  })
         *  .execute(); // execute the changes
         * ```
         *
         * @method prepare
         */
        prepare(prepareChangesFn) {
            let changes = get(this, '_bareChanges');
            let preparedChanges = prepareChangesFn(changes);
            assert('Callback to `changeset.prepare` must return an object', isObject(preparedChanges));
            validateNestedObj('preparedChanges', preparedChanges);
            let newObj = {};
            let newChanges = keys(preparedChanges).reduce((newObj, key) => {
                newObj[key] = new Change(preparedChanges[key]);
                return newObj;
            }, newObj);
            set(this, CHANGES, newChanges);
            return this;
        },
        /**
         * Executes the changeset if in a valid state.
         *
         * @method execute
         */
        execute() {
            if (get(this, 'isValid') && get(this, 'isDirty')) {
                let content = get(this, CONTENT);
                let changes = get(this, CHANGES);
                keys(changes).forEach(key => deepSet(content, key, changes[key].value));
            }
            return this;
        },
        /**
         * Executes the changeset and saves the underlying content.
         *
         * @method save
         * @param {Object} options optional object to pass to content save method
         */
        save(options) {
            let content = get(this, CONTENT);
            let savePromise = resolve(this);
            this.execute();
            if (typeof content.save === 'function') {
                savePromise = content.save(options);
            }
            else if (typeof get(content, 'save') === 'function') {
                // we might be getting this off a proxy object.  For example, when a
                // belongsTo relationship (a proxy on the parent model)
                // another way would be content(belongsTo).content.save
                let saveFunc = get(content, 'save');
                if (saveFunc) {
                    savePromise = saveFunc(options);
                }
            }
            return resolve(savePromise).then((result) => {
                this.rollback();
                return result;
            });
        },
        /**
         * Merges 2 valid changesets and returns a new changeset. Both changesets
         * must point to the same underlying object. The changeset target is the
         * origin. For example:
         *
         * ```
         * let changesetA = new Changeset(user, validatorFn);
         * let changesetB = new Changeset(user, validatorFn);
         * changesetA.set('firstName', 'Jim');
         * changesetB.set('firstName', 'Jimmy');
         * changesetB.set('lastName', 'Fallon');
         * let changesetC = changesetA.merge(changesetB);
         * changesetC.execute();
         * user.get('firstName'); // "Jimmy"
         * user.get('lastName'); // "Fallon"
         * ```
         *
         * @method merge
         */
        merge(changeset) {
            let content = get(this, CONTENT);
            assert('Cannot merge with a non-changeset', isChangeset(changeset));
            assert('Cannot merge with a changeset of different content', get(changeset, CONTENT) === content);
            if (get(this, 'isPristine') && get(changeset, 'isPristine')) {
                return this;
            }
            let c1 = get(this, CHANGES);
            let c2 = get(changeset, CHANGES);
            let e1 = get(this, ERRORS);
            let e2 = get(changeset, ERRORS);
            let newChangeset = new Changeset(content, get(this, VALIDATOR)); // ChangesetDef
            let newErrors = objectWithout(keys(c2), e1);
            let newChanges = objectWithout(keys(e2), c1);
            let mergedErrors = mergeNested(newErrors, e2);
            let mergedChanges = mergeNested(newChanges, c2);
            newChangeset[ERRORS] = mergedErrors;
            newChangeset[CHANGES] = mergedChanges;
            newChangeset._notifyVirtualProperties();
            return newChangeset;
        },
        /**
         * Returns the changeset to its pristine state, and discards changes and
         * errors.
         *
         * @method rollback
         */
        rollback() {
            // Get keys before reset.
            let c = this;
            let keys = c._rollbackKeys();
            // Reset.
            set(this, CHANGES, {});
            set(this, ERRORS, {});
            c._notifyVirtualProperties(keys);
            c.trigger(AFTER_ROLLBACK_EVENT);
            return this;
        },
        /**
         * Discards any errors, keeping only valid changes.
         *
         * @public
         * @chainable
         * @method rollbackInvalid
         * @param {String} key optional key to rollback invalid values
         * @return {Changeset}
         */
        rollbackInvalid(key) {
            let errorKeys = keys(get(this, ERRORS));
            if (key) {
                this._notifyVirtualProperties([key]);
                this._deleteKey(ERRORS, key);
                if (errorKeys.indexOf(key) > -1) {
                    this._deleteKey(CHANGES, key);
                }
            }
            else {
                this._notifyVirtualProperties();
                set(this, ERRORS, {});
                // if on CHANGES hash, rollback those as well
                errorKeys.forEach((errKey) => {
                    this._deleteKey(CHANGES, errKey);
                });
            }
            return this;
        },
        /**
         * Discards changes/errors for the specified properly only.
         *
         * @public
         * @chainable
         * @method rollbackProperty
         * @param {String} key key to delete off of changes and errors
         * @return {Changeset}
         */
        rollbackProperty(key) {
            this._deleteKey(CHANGES, key);
            this._deleteKey(ERRORS, key);
            return this;
        },
        /**
         * Validates the changeset immediately against the validationMap passed in.
         * If no key is passed into this method, it will validate all fields on the
         * validationMap and set errors accordingly. Will throw an error if no
         * validationMap is present.
         *
         * @method validate
         */
        validate(key) {
            if (keys(validationMap).length === 0) {
                return resolve(null);
            }
            if (isNone(key)) {
                let maybePromise = keys(validationMap).map(validationKey => {
                    return this._validateKey(validationKey, this._valueFor(validationKey));
                });
                return all(maybePromise);
            }
            return resolve(this._validateKey(key, this._valueFor(key)));
        },
        /**
         * Manually add an error to the changeset. If there is an existing
         * error or change for `key`, it will be overwritten.
         *
         * @method addError
         */
        addError(key, error) {
            // Construct new `Err` instance.
            let newError;
            if (isObject(error)) {
                assert('Error must have value.', error.hasOwnProperty('value'));
                assert('Error must have validation.', error.hasOwnProperty('validation'));
                newError = new Err(error.value, error.validation);
            }
            else {
                newError = new Err(get(this, key), error);
            }
            // Add `key` to errors map.
            let errors = get(this, ERRORS);
            setNestedProperty(errors, key, newError);
            this.notifyPropertyChange(ERRORS);
            // Notify that `key` has changed.
            this.notifyPropertyChange(key);
            // Return passed-in `error`.
            return error;
        },
        /**
         * Manually push multiple errors to the changeset as an array.
         *
         * @method pushErrors
         */
        pushErrors(key, ...newErrors) {
            let errors = get(this, ERRORS);
            let existingError = errors[key] || new Err(null, []);
            let validation = existingError.validation;
            let value = get(this, key);
            if (!isArray(validation) && isPresent(validation)) {
                existingError.validation = [validation];
            }
            let v = existingError.validation;
            validation = [...v, ...newErrors];
            let newError = new Err(value, validation);
            setNestedProperty(errors, key, newError);
            this.notifyPropertyChange(ERRORS);
            this.notifyPropertyChange(key);
            return { value, validation };
        },
        /**
         * Creates a snapshot of the changeset's errors and changes.
         *
         * @method snapshot
         */
        snapshot() {
            let changes = get(this, CHANGES);
            let errors = get(this, ERRORS);
            return {
                changes: keys(changes).reduce((newObj, key) => {
                    newObj[key] = changes[key].value;
                    return newObj;
                }, {}),
                errors: keys(errors).reduce((newObj, key) => {
                    let e = errors[key];
                    newObj[key] = { value: e.value, validation: e.validation };
                    return newObj;
                }, {}),
            };
        },
        /**
         * Restores a snapshot of changes and errors. This overrides existing
         * changes and errors.
         *
         * @method restore
         */
        restore({ changes, errors }) {
            validateNestedObj('snapshot.changes', changes);
            validateNestedObj('snapshot.errors', errors);
            let newChanges = keys(changes).reduce((newObj, key) => {
                newObj[key] = new Change(changes[key]);
                return newObj;
            }, {});
            let newErrors = keys(errors).reduce((newObj, key) => {
                let e = errors[key];
                newObj[key] = new Err(e.value, e.validation);
                return newObj;
            }, {});
            set(this, CHANGES, newChanges);
            set(this, ERRORS, newErrors);
            this._notifyVirtualProperties();
            return this;
        },
        /**
         * Unlike `Ecto.Changeset.cast`, `cast` will take allowed keys and
         * remove unwanted keys off of the changeset. For example, this method
         * can be used to only allow specified changes through prior to saving.
         *
         * @method cast
         */
        cast(allowed = []) {
            let changes = get(this, CHANGES);
            if (isArray(allowed) && allowed.length === 0) {
                return this;
            }
            let changeKeys = keys(changes);
            let validKeys = emberArray(changeKeys).filter((key) => includes(allowed, key));
            let casted = take(changes, validKeys);
            set(this, CHANGES, casted);
            return this;
        },
        /**
         * Checks to see if async validator for a given key has not resolved.
         * If no key is provided it will check to see if any async validator is running.
         *
         * @method isValidating
         */
        isValidating(key) {
            let runningValidations = get(this, RUNNING_VALIDATIONS);
            let ks = emberArray(keys(runningValidations));
            if (key) {
                return includes(ks, key);
            }
            return !isEmpty(ks);
        },
        /**
         * Validates a specific key
         *
         * @method _validateKey
         * @private
         */
        _validateKey(key, value) {
            let content = get(this, CONTENT);
            let oldValue = get(content, key);
            let validation = this._validate(key, value, oldValue);
            this.trigger(BEFORE_VALIDATION_EVENT, key);
            // TODO: Address case when Promise is rejected.
            if (isPromise(validation)) {
                this._setIsValidating(key, true);
                return validation.then((resolvedValidation) => {
                    this._setIsValidating(key, false);
                    this.trigger(AFTER_VALIDATION_EVENT, key);
                    return this._handleValidation(resolvedValidation, { key, value });
                });
            }
            let result = this._handleValidation(validation, { key, value });
            this.trigger(AFTER_VALIDATION_EVENT, key);
            return result;
        },
        /**
         * Takes resolved validation and adds an error or simply returns the value
         *
         * @method _handleValidation
         * @private
         */
        _handleValidation(validation, { key, value }) {
            let isValid = validation === true
                || isArray(validation)
                    && validation.length === 1
                    && validation[0] === true;
            // Happy path: remove `key` from error map.
            this._deleteKey(ERRORS, key);
            // Error case.
            if (!isValid) {
                return this.addError(key, { value, validation });
            }
            return value;
        },
        /**
         * runs the validator with the key and value
         *
         * @method _validate
         * @private
         */
        _validate(key, newValue, oldValue) {
            let validator = get(this, VALIDATOR);
            let content = get(this, CONTENT);
            if (typeof validator === 'function') {
                let isValid = validator({
                    key,
                    newValue,
                    oldValue,
                    changes: get(this, 'change'),
                    content,
                });
                return isPresent(isValid) ? isValid : true;
            }
            return true;
        },
        /**
         * Sets property or error on the changeset.
         * Returns value or error
         */
        _setProperty({ key, value, oldValue }) {
            let changes = get(this, CHANGES);
            // Happy path: update change map.
            if (!isEqual(oldValue, value)) {
                setNestedProperty(changes, key, new Change(value));
            }
            else if (key in changes) {
                this._deleteKey(CHANGES, key);
            }
            // Happy path: notify that `key` was added.
            this.notifyPropertyChange(CHANGES);
            this.notifyPropertyChange(key);
        },
        /**
         * Increment or decrement the number of running validations for a
         * given key.
         */
        _setIsValidating(key, value) {
            let running = get(this, RUNNING_VALIDATIONS);
            let count = get(running, key) || 0;
            if (!value && count === 1) {
                delete running[key];
                return;
            }
            deepSet(running, key, value ? count + 1 : count - 1);
        },
        /**
         * Value for change or the original value.
         */
        _valueFor(key) {
            let changes = get(this, CHANGES);
            let errors = get(this, ERRORS);
            let content = get(this, CONTENT);
            if (errors.hasOwnProperty(key)) {
                let e = errors[key];
                return e.value;
            }
            let original = get(content, key);
            if (changes.hasOwnProperty(key)) {
                let c = changes[key];
                return c.value;
            }
            // nested thus circulate through `value` and see if match
            if (key.indexOf('.') !== -1) {
                let [baseKey, ...keyParts] = key.split('.');
                if (changes.hasOwnProperty(baseKey)) {
                    let { value } = changes[baseKey];
                    // make sure to return value if not object
                    if (!value) {
                        return value;
                    }
                    let result = get(value, keyParts.join('.'));
                    return result;
                }
            }
            return original;
        },
        /**
         * Notifies virtual properties set on the changeset of a change.
         * You can specify which keys are notified by passing in an array.
         *
         * @private
         * @param {Array} keys
         * @return {Void}
         */
        _notifyVirtualProperties(keys) {
            if (!keys) {
                keys = this._rollbackKeys();
            }
            (keys || []).forEach(key => this.notifyPropertyChange(key));
        },
        /**
         * Gets the changes and error keys.
         */
        _rollbackKeys() {
            let changes = get(this, CHANGES);
            let errors = get(this, ERRORS);
            return emberArray([...keys(changes), ...keys(errors)]).uniq();
        },
        /**
         * Deletes a key off an object and notifies observers.
         */
        _deleteKey(objName, key = '') {
            let obj = get(this, objName);
            if (obj.hasOwnProperty(key)) {
                delete obj[key];
            }
            let c = this;
            c.notifyPropertyChange(`${objName}.${key}`);
            c.notifyPropertyChange(objName);
        },
        get(key) {
            if (key.indexOf('.') > -1) {
                // pull off changes hash with full key instead of
                // breaking up key
                return this.unknownProperty(key);
            }
            else {
                return this._super(...arguments);
            }
        },
        set(key, value) {
            if (key.indexOf('.') > -1) {
                // Adds new CHANGE and avoids ember intenals setting directly on model
                // TODO: overriding `set(changeset, )` doesnt work
                return this.setUnknownProperty(key, value);
            }
            else {
                return this._super(...arguments);
            }
        }
    };
    return EmberObject.extend(Evented, changeset);
}
export default class Changeset {
    /**
     * Changeset factory
     *
     * @class Changeset
     * @constructor
     */
    constructor(obj, validateFn = defaultValidatorFn, validationMap = {}, options = {}) {
        return changeset(obj, validateFn, validationMap, options).create();
    }
}
