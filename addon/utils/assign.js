export default function pureAssign(...objects) {
    return objects.reduce((acc, obj) => {
        return Object.defineProperties(acc, Object.getOwnPropertyDescriptors(obj));
    }, {});
}
