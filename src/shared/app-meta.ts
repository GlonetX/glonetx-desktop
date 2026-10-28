/**
 * GlonetX 分支的构建标识。
 *
 * 版本号本身必须保持合法的三段 semver（构建流程与自动更新都依赖它），
 * 因此 "这是 GlonetX 的构建" 这件事通过下面的常量在界面上标注，而不是写进 version。
 */
export const forkName = 'GlonetX'

export const forkBuildLabel = `${forkName} 构建`
