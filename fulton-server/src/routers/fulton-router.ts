import * as assert from "assert";
import * as lodash from "lodash";

import { ErrorMiddleware, FultonApp, Request, Response, Middleware, asyncHandler } from "../index";
import { FullRouterMetadata, RouterMetadata, getFullRouterMethodMetadata, getRouterMetadata } from "./route-decorators-helpers";
import { FultonDiContainer, PathIdentifier, Inject, Injectable } from "../interfaces";
import { IRouterMatcher, Router } from "express";

import { Identifier } from "../helpers/type-helpers";
import { KEY_FULTON_APP } from "../constants";

/**
 * Express Router Wrap, it support async await
 * 
 * ## example
 * 
 * ```
 * @Router("/Food")
 * export class FoodRouter extends FultonRouter {
 *    @httpGet()
 *    async list(req: Request, res: Response) { }
 * 
 *    @httpGet("/:id")
 *    async detail(req: Request, res: Response) { }
 * }
 * ```
 * 
 */
@Injectable()
export abstract class FultonRouter {
    protected metadata: FullRouterMetadata
    protected router: Router;
    @Inject(KEY_FULTON_APP)
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

            var router = Router();

        if (lodash.some(this.metadata.router.middlewares)) {
            router.use(...this.metadata.router.middlewares);
        }

        for (const methodMetadata of this.metadata.methods) {
            let routeMethod: IRouterMatcher<any> = lodash.get(router, methodMetadata.method);
            let middlewares: Middleware[] = [];

            if (lodash.some(methodMetadata.middlewares)) {
                middlewares.push(...methodMetadata.middlewares);
            }

            let method = lodash.get(this, methodMetadata.property);
            middlewares.push(asyncHandler(method));

            routeMethod.call(router, methodMetadata.path, middlewares)
        }

        if (this.metadata.errorhandler) {
            router.use(lodash.get(router, this.metadata.errorhandler));
        }

        this.app.server.use(this.metadata.router.path, router);
    }

    protected onInit() { }
}
