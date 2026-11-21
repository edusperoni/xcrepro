#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface SampleGreeter : NSObject
- (NSString *)greet:(NSString *)name;
/// Expands __FILE__, so a missing -ffile-prefix-map shows up as an absolute path in the binary.
- (NSString *)sourceFile;
@end

NS_ASSUME_NONNULL_END
