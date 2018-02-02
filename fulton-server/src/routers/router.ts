import * as assert from "assert";
import * as lodash from "lodash";

import { ErrorMiddleware, FultonApp, Request, Response, Middleware, asyncWrap } from "../index";
import { FullRouterMetadata, RouterMetadata, getFullRouterMethodMetadata, getRouterMetadata } from "./route-decorators-helpers";
import { DiContainer, PathIdentifier, inject, injectable } from "../interfaces";
import { IRouterMatcher, Router as ExpressRouter } from "express";

import { TypeIdentifier } from "../helpers/type-helpers";

/**
 * Express Router Wrap, it uses asyncHandler to support async await
 * 
 * ## example
 * 
 * ```
 * @router("/Food")
 * export class FoodRouter extends Router {
 *    @httpGet()
 *    async list(req: Request, res: Response) { 
 *      return true; //if return true, asyncHandler will all next();
 *    }
 * 
 *    @httpGet("/:id")
 *    async detail(req: Request, res: Response, next: NextFunction) { 
 *       next(); // call next() yourself;
 *    }
 * 
 *    @httpPost()
 *    async create(req: Request, res: Response) { 
 *       // if retrun not true,  asyncHandler won't call next();
 *    }
 * }
 * ```
 * 
 */
@injectable()
export abstract class Router {
    protected metadata: FullRouterMetadata
    protected router: Router;
    @inject(FultonApp)
    protected app: FultonApp;

    constructor() {
        this.loadMetadata();
    }

    protected loadMetadata() {
        this.metadata = getFullRouterMethodMetadata(this.constructor);
    }

    init() {
        //TODO: valify metadata;
        this.onInit();

        assert(this.metadata.router, `${this.constructor.name} don't have @router(path) decorator`)
        if (this.metadata.router)

            var router = ExpressRouter();

        if (lodash.some(this.metadata.router.middlewares)) {
            router.use(...this.metadata.router.middlewares);
        }

        for (const methodMetadata of this.metadata.methods) {
            let routeMethod: IRouterMatcher<any> = lodash.get(router, methodMetadata.method);
            let middlewares: Middleware[] = [];

            if (lodash.some(methodMetadata.middlewares)) {
                middlewares.push(...methodMetadata.middlewares);
            }

            let method: Middleware = lodash.get(this, methodMetadata.property);
            method = method.bind(this);
            middlewares.push(asyncWrap(method));

            routeMethod.call(router, methodMetadata.path, middlewares)
        }

        if (this.metadata.errorhandler) {
            router.use(lodash.get(router, this.metadata.errorhandler));
        }

        this.app.express.use(this.metadata.router.path, router);
    }

    protected onInit() { }
}